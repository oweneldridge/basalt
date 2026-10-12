#!/usr/bin/env node
// Diffs what Obsidian and Basalt left on disk for each variant of a run:
// node parity/diff.mjs ~/parity-vaults/<stamp>
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// App state, not notes: each app keeps its own.
const SKIP = new Set([".obsidian", ".basalt", ".trash", ".DS_Store"]);
const run = process.argv[2];
if (!run || !existsSync(join(run, "obsidian"))) {
  process.stderr.write("Usage: node parity/diff.mjs <run folder made by parity/prepare.mjs>\n");
  process.exit(2);
}
let differs = false;
const work = mkdtempSync(join(tmpdir(), "parity-diff-"));
for (const variant of readdirSync(join(run, "obsidian"))) {
  const sides = ["obsidian", "basalt"].map((app) => {
    const to = join(work, variant, app);
    cpSync(join(run, app, variant), to, { recursive: true, filter: (src) => !SKIP.has(basename(src)) });
    return to;
  });
  const out = spawnSync("git", ["diff", "--no-index", "--no-color", "--text", "--find-renames", ...sides], { encoding: "utf8" });
  const text = out.stdout.split(work).join("");
  process.stdout.write(`== ${variant}: ${out.status === 0 ? "same" : "differs"}\n${text}`);
  if (out.status !== 0) differs = true;
}
rmSync(work, { recursive: true, force: true });
process.exit(differs ? 1 : 0);
