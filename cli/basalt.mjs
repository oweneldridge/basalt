#!/usr/bin/env node
// basalt — command-line access to a Basalt/Obsidian vault. Operates directly on
// the vault's Markdown files (no running app required), so it's usable headless
// (e.g. from Claude Code). `open` hands a basalt:// URI to the OS.
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { run } from "./core.mjs";

// Directories never treated as note content.
const SKIP = new Set([".obsidian", ".basalt", ".trash", ".git", "node_modules"]);

function listMarkdown(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push({ rel: relative(root, full).split(sep).join("/"), path: full });
    }
  };
  walk(root);
  return out;
}

function openUri(uri) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", uri] : [uri];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    process.stderr.write(`Couldn't open ${uri}: ${e.message}\n`);
  }
}

const io = {
  cwd: process.cwd(),
  env: process.env,
  fileExists: (p) => existsSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  listMarkdown,
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, content) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  },
  openUri,
  out: (t) => process.stdout.write(t + "\n"),
  err: (t) => process.stderr.write(t + "\n"),
};

process.exit(run(process.argv.slice(2), io));
