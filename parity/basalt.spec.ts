// Does parity/rename.md's steps in Basalt, on a copy of each seed vault, and
// leaves the result in <run>/basalt/<variant> for parity/diff.mjs.
import { test, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN = process.env.PARITY_RUN ?? "";

async function serve(dir: string) {
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env, BASALT_PORT: String(port), BASALT_HOST: "127.0.0.1", BASALT_WEB_DIR: join(ROOT, "dist") };
  delete env.BASALT_AUTH;
  delete env.BASALT_VAULT;
  const proc = spawn(join(ROOT, "target/debug/basalt-server"), ["--vault", dir], { env, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/api/vault-root`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { url, stop: () => new Promise<void>((r) => (proc.exitCode !== null ? r() : (proc.once("exit", () => r()), proc.kill()))) };
}

async function rename(page: Page, row: string, to: string, folder = false) {
  await treeRow(page, row, folder).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: folder ? "Rename folder…" : "Rename…" }).click();
  await page.locator(".prompt-input").fill(to);
  await page.locator(".prompt-input").press("Enter");
}

// A folder row is named "▸ Name" (or "▾ Name" when open), a file "Name" and
// any type badge ("pic png").
const treeRow = (page: Page, name: string, folder = false) =>
  page.locator(folder ? ".tree-row.folder" : ".tree-row.file").and(page.getByRole("button", { name: new RegExp(folder ? `^[▸▾] ${name}$` : `^${name}(?: [a-z]+)?$`) })).first();
const open = (page: Page, folder: string) => treeRow(page, folder, true).click();

test.skip(!RUN || !existsSync(join(RUN, "seed")), "set PARITY_RUN to a folder made by parity/prepare.mjs");

for (const variant of RUN && existsSync(join(RUN, "seed")) ? readdirSync(join(RUN, "seed")) : []) {
  test(variant, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), `parity-${variant}-`));
    cpSync(join(RUN, "seed", variant), dir, { recursive: true });
    const server = await serve(dir);
    try {
      await page.goto(server.url + "/");
      await expect(page.locator(".sidebar")).toBeVisible();
      const settle = () => page.waitForTimeout(1500);
      await rename(page, "Target", "Target Renamed");
      await expect.poll(() => existsSync(join(dir, "Target Renamed.md"))).toBe(true);
      await settle();
      await open(page, "Folder");
      await rename(page, "Deep", "Archive/Deep");
      await expect.poll(() => existsSync(join(dir, "Archive/Deep.md"))).toBe(true);
      await settle();
      await rename(page, "Folder", "Folder2", true);
      await expect.poll(() => existsSync(join(dir, "Folder2/Sub/Leaf.md"))).toBe(true);
      await settle();
      await open(page, "assets");
      await rename(page, "pic", "assets/picture");
      await expect.poll(() => existsSync(join(dir, "assets/picture.png"))).toBe(true);
      await settle();
    } finally {
      await server.stop();
    }
    rmSync(join(RUN, "basalt", variant), { recursive: true, force: true });
    cpSync(dir, join(RUN, "basalt", variant), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  });
}
