import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Vault } from "./fixture";

// Other tests create temp vaults next to ours in parallel, so only look for the
// names an escape would produce.
const escapes = (dir: string) => readdirSync(dir).filter((n) => /escape|outside/.test(n));

async function invoke(vault: Vault, cmd: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await fetch(`${vault.url}/api/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ cmd, args }),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as { result?: unknown; error?: string } | null };
}

test("path-taking commands refuse to reach outside the vault", async ({ vault }) => {
  const outside = join(dirname(vault.dir), `basalt-escape-${Date.now()}`);
  const parentBefore = escapes(dirname(vault.dir));
  const b64 = Buffer.from("x").toString("base64");
  const attempts: [string, Record<string, unknown>][] = [
    ["read_note", { path: "/etc/hosts" }],
    ["read_note", { path: `${vault.dir}/../../../../etc/hosts` }],
    ["write_note", { path: `${outside}.md`, content: "pwned" }],
    ["write_note", { path: `${vault.dir}/../${outside.split("/").pop()}.md`, content: "pwned" }],
    ["create_note", { name: "../../escape" }],
    ["rename_note", { path: vault.path("Ideas.md"), newName: "../escape" }],
    ["delete_note", { path: "/etc/hosts" }],
    ["create_folder", { rel: "../escape-dir" }],
    ["rename_folder", { fromRel: "Projects", toRel: "../escape-dir" }],
    ["delete_folder", { rel: ".." }],
    ["write_attachment", { name: "../escape.png", dataB64: b64, sourceRel: "Ideas.md" }],
    ["read_image", { target: "../../../../etc/hosts", sourceRel: "Ideas.md" }],
    ["write_plugin_data", { id: "../../escape", data: "{}" }],
    ["toggle_file_bookmark", { path: "/etc/hosts" }],
    ["export_file", { path: `${outside}.html`, content: "x" }],
  ];
  for (const [cmd, args] of attempts) {
    const { status, body } = await invoke(vault, cmd, args);
    expect(status, `${cmd} ${JSON.stringify(args)}`).toBe(200);
    expect(body?.error, `${cmd} ${JSON.stringify(args)} should fail`).toBeTruthy();
  }
  expect(escapes(dirname(vault.dir))).toEqual(parentBefore);
  expect(vault.exists("Ideas.md")).toBe(true);
  expect(vault.exists("Projects/Alpha.md")).toBe(true);
});

test.describe("with a note-relative attachment folder", () => {
  test.use({ vaultFiles: { ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "./assets" }) } });
  test("a source note path can't steer an attachment outside the vault", async ({ vault }) => {
    const parentBefore = escapes(dirname(vault.dir));
    const b64 = Buffer.from("x").toString("base64");
    for (const sourceRel of ["../../outside.md", "../outside.md", "/tmp/outside.md", ".obsidian/x.md"]) {
      const { body } = await invoke(vault, "write_attachment", { name: "x.png", dataB64: b64, sourceRel });
      expect(body?.error, sourceRel).toBeTruthy();
    }
    expect(escapes(dirname(vault.dir))).toEqual(parentBefore);
  });
});

test("write_note refuses non-Markdown targets inside the vault", async ({ vault }) => {
  for (const rel of [".basalt/plugins/evil/main.js", ".obsidian/app.json", "Board.canvas"]) {
    const { body } = await invoke(vault, "write_note", { path: vault.path(rel), content: "x" });
    expect(body?.error, rel).toBeTruthy();
  }
  expect(vault.read(".obsidian/app.json")).toContain("newLinkFormat");
});

test("a cross-site simple request can't reach the command endpoint", async ({ vault }) => {
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const r = await fetch(`${vault.url}/api/invoke`, {
      method: "POST",
      headers: { "Content-Type": type },
      body: JSON.stringify({ cmd: "delete_note", args: { path: vault.path("Ideas.md") } }),
    });
    expect(r.status, type).toBeGreaterThanOrEqual(400);
  }
  expect(vault.exists("Ideas.md")).toBe(true);
});

test("there is no permissive CORS on the command endpoint", async ({ vault }) => {
  const r = await fetch(`${vault.url}/api/invoke`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
});

test("with auth off, a request for another host name is refused", async ({ vault }) => {
  const port = new URL(vault.url).port;
  const { request } = await import("node:http");
  const status = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/vault-root", headers: { Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
  expect(await status(`rebind.attacker.example:${port}`)).toBe(403);
  expect(await status(`localhost:${port}`)).toBe(200);
  expect(await status(`127.0.0.1:${port}`)).toBe(200);
  expect(await status(`[::1]:${port}`)).toBe(200);
});

test.describe("with auth on", () => {
  test.use({ auth: "owner:correct horse" });
  test("every route needs the credentials", async ({ vault }) => {
    const good = { Authorization: `Basic ${Buffer.from("owner:correct horse").toString("base64")}` };
    const bad = { Authorization: `Basic ${Buffer.from("owner:wrong").toString("base64")}` };
    for (const [path, init] of [
      ["/api/invoke", { method: "POST", body: JSON.stringify({ cmd: "read_vault", args: {} }) }],
      ["/api/events", {}],
      ["/api/vault-root", {}],
      ["/", {}],
      ["/index.html", {}],
      ["/some/spa/route", {}],
    ] as [string, RequestInit][]) {
      for (const headers of [{}, bad]) {
        const r = await fetch(vault.url + path, { ...init, headers: { "Content-Type": "application/json", ...headers } });
        expect(r.status, `${path} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    const ok = await invoke(vault, "read_note", { path: vault.path("Ideas.md") }, good);
    expect(ok.body?.result).toContain("# Ideas");
  });
});
