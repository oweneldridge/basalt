import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Real-IO end-to-end tests: each test gets a fresh copy of e2e-real/vault in a
// temp dir and its own basalt-server process serving the production dist/, so
// the real Rust core, watcher and disk writes are in the loop.

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "target/debug/basalt-server");
const TEMPLATE = join(ROOT, "e2e-real/vault");

export interface Vault {
  dir: string;
  url: string;
  path(rel: string): string;
  read(rel: string): string;
  readBytes(rel: string): Buffer;
  write(rel: string, content: string | Uint8Array): void;
  exists(rel: string): boolean;
  stop(): Promise<void>;
  start(): Promise<void>;
  log(): string;
}

export interface VaultOptions {
  /** Extra files written into the vault before the server starts. */
  vaultFiles: Record<string, string | Uint8Array>;
  /** "user:pass" to boot the server with HTTP Basic auth. */
  auth: string | null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitUp(url: string, auth: string | null) {
  const headers: Record<string, string> = auth ? { Authorization: `Basic ${Buffer.from(auth).toString("base64")}` } : {};
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${url}/api/vault-root`, { headers });
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`basalt-server did not come up at ${url}`);
}

export const test = base.extend<VaultOptions & { vault: Vault }>({
  vaultFiles: [{}, { option: true }],
  auth: [null, { option: true }],
  vault: async ({ vaultFiles, auth }, use) => {
    if (!existsSync(SERVER)) throw new Error("build the server first: cargo build -p basalt-server");
    const dir = mkdtempSync(join(tmpdir(), "basalt-e2e-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    for (const [rel, content] of Object.entries(vaultFiles)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let proc: ChildProcess | null = null;
    let log = "";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BASALT_PORT: String(port),
      BASALT_HOST: "127.0.0.1",
      BASALT_WEB_DIR: join(ROOT, "dist"),
    };
    delete env.BASALT_AUTH;
    delete env.BASALT_VAULT;
    if (auth) env.BASALT_AUTH = auth;

    const start = async () => {
      proc = spawn(SERVER, ["--vault", dir], { env, stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout?.on("data", (d) => (log += d));
      proc.stderr?.on("data", (d) => (log += d));
      await waitUp(url, auth);
    };
    const stop = async () => {
      const p = proc;
      proc = null;
      if (!p || p.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        p.once("exit", () => resolve());
        p.kill();
      });
    };

    await start();
    await use({
      dir,
      url,
      path: (rel) => join(dir, rel),
      read: (rel) => readFileSync(join(dir, rel), "utf8"),
      readBytes: (rel) => readFileSync(join(dir, rel)),
      write: (rel, content) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      },
      exists: (rel) => existsSync(join(dir, rel)),
      stop,
      start,
      log: () => log,
    });
    await stop();
    rmSync(dir, { recursive: true, force: true });
  },
});

export { expect };

/** Load the web app against this test's server and wait for the file tree. */
export async function openApp(page: Page, vault: Vault) {
  await page.goto(vault.url + "/");
  await expect(page.locator(".sidebar")).toBeVisible();
}

/** Open a note from the file tree and wait for its editor. */
export async function openNote(page: Page, name: string) {
  await page.locator(".tree-row.file", { hasText: name }).first().click();
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText(name);
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toBeVisible();
}

/** Put the caret at the end of the focused editor's document. */
export async function caretToEnd(page: Page) {
  const content = page.locator(".pane:not(.dock) .cm-content").first();
  await content.click();
  await page.keyboard.press("ControlOrMeta+End");
}

/** Wait until autosave has had time to fire and the status bar is idle. */
export async function settle(page: Page, ms = 900) {
  await page.waitForTimeout(ms);
  await expect(page.locator(".status").first()).not.toHaveText("Saving…");
}
