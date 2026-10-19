#!/usr/bin/env node
// Makes a parity run: ~/parity-vaults/<stamp>/{seed,obsidian}/<variant>, or
// under the folder given. Outside iCloud, so nothing here syncs anywhere.
import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { seed, VARIANTS } from "./seed.mjs";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const run = join(process.argv[2] ?? join(homedir(), "parity-vaults"), stamp);
for (const [name, settings] of Object.entries(VARIANTS)) {
  seed(join(run, "seed", name), settings);
  cpSync(join(run, "seed", name), join(run, "obsidian", name), { recursive: true });
}
mkdirSync(join(run, "basalt"), { recursive: true });
process.stdout.write(`${run}\n`);
