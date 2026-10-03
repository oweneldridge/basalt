import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test, expect } from "@playwright/test";
import { ROOT } from "./fixture";

// Opt-in smoke test against a large vault COPY (never point this at a live
// vault): BASALT_E2E_BIG_VAULT=/path/to/copy npm run test:e2e:real
const BIG = process.env.BASALT_E2E_BIG_VAULT;

function mtimes(dir: string, out = new Map<string, number>()) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) mtimes(p, out);
    else if (e.isFile()) out.set(p, statSync(p).mtimeMs);
  }
  return out;
}

test.skip(!BIG, "set BASALT_E2E_BIG_VAULT to a vault copy");
test.setTimeout(180_000);

test("a large vault opens, browses and stays untouched", async ({ page }) => {
  const before = mtimes(BIG!);
  const port = 8790 + Math.floor(Math.random() * 100);
  const env: NodeJS.ProcessEnv = { ...process.env, BASALT_PORT: String(port), BASALT_HOST: "127.0.0.1", BASALT_WEB_DIR: join(ROOT, "dist") };
  delete env.BASALT_AUTH;
  const proc = spawn(join(ROOT, "target/debug/basalt-server"), ["--vault", BIG!], { env, stdio: "ignore" });
  try {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/api/vault-root`).catch(() => null))?.ok).toBe(true);
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/`);
    await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 60_000 });
    const loadMs = Date.now() - t0;
    const rows = page.locator(".tree-row.file");
    const n = Math.min(await rows.count(), 8);
    for (let i = 0; i < n; i++) {
      await rows.nth(i).click();
      await expect(page.locator(".pane:not(.dock) .cm-content, .pane:not(.dock) .canvas-world, .pane:not(.dock) .base-view").first()).toBeVisible();
    }
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await page.keyboard.type("meeting");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape");
    test.info().annotations.push({ type: "load", description: `${loadMs}ms to first tree row; opened ${n} notes` });
    await page.waitForTimeout(1500);
    expect(errors, errors.join("\n")).toEqual([]);
    const after = mtimes(BIG!);
    const changed = [...after].filter(([p, m]) => before.get(p) !== m).map(([p]) => p);
    const removed = [...before.keys()].filter((p) => !after.has(p) && !p.includes(".basalt-tmp-"));
    expect(changed, "files modified by browsing").toEqual([]);
    expect(removed, "files removed by browsing").toEqual([]);
  } finally {
    proc.kill();
  }
});
