import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// The CLI core is plain ESM JS (runs under node with no build step).
import { parseArgs, findVaultRoot, resolveNote, searchNotes, noteRelForTitle, openUri, run } from "../../cli/core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "../../cli/basalt.mjs");

// ---- fake io for run() ----------------------------------------------------
function makeIo(vault: string, files: Record<string, string>, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const store = { ...files }; // abs path → content
  const io = {
    cwd: "/wherever",
    env: { BASALT_VAULT: vault, ...env },
    fileExists: (p: string) => p in store || p === vault + "/.obsidian",
    isDir: (p: string) => p === vault,
    listMarkdown: (root: string) =>
      Object.keys(store)
        .filter((p) => p.startsWith(root + "/") && p.endsWith(".md"))
        .map((p) => ({ rel: p.slice(root.length + 1), path: p })),
    readFile: (p: string) => store[p] ?? "",
    writeFile: (p: string, content: string) => {
      store[p] = content;
    },
    openUri: (u: string) => opened.push(u),
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
  };
  return { io, out, err, opened, store };
}
const VAULT = "/v";
const FILES = {
  "/v/Journal/2026-07-05.md": "# 2026-07-05\nMet Alice about the API.\n",
  "/v/Projects/Basalt.md": "# Basalt\nAnti-enshittification PKM.\n- [ ] ship the CLI\n",
  "/v/Index.md": "welcome\n",
};

describe("cli core helpers", () => {
  it("parseArgs separates value flags, booleans, and positionals", () => {
    const p = parseArgs(["search", "hello world", "--limit", "5", "--json", "--vault=/x"]);
    expect(p.command).toBe("search");
    expect(p.args).toEqual(["hello world"]);
    expect(p.opts).toEqual({ limit: "5", json: true, vault: "/x" });
  });

  it("findVaultRoot walks up to an .obsidian/.basalt marker", () => {
    const io = { fileExists: (p: string) => p === "/home/me/vault/.obsidian" };
    expect(findVaultRoot("/home/me/vault/Journal/sub", io)).toBe("/home/me/vault");
    expect(findVaultRoot("/tmp/nowhere", { fileExists: () => false })).toBeNull();
  });

  it("resolveNote prefers exact rel, then basename, then contains", () => {
    const notes = [
      { rel: "Journal/2026-07-05.md", path: "a" },
      { rel: "Projects/Basalt.md", path: "b" },
    ];
    expect(resolveNote(notes, "Projects/Basalt")!.path).toBe("b");
    expect(resolveNote(notes, "Basalt")!.path).toBe("b"); // basename
    expect(resolveNote(notes, "basalt")!.path).toBe("b"); // case-insensitive
    expect(resolveNote(notes, "2026-07")!.path).toBe("a"); // contains
    expect(resolveNote(notes, "nope")).toBeNull();
  });

  it("searchNotes greps bodies, honors --regex and --limit", () => {
    const notes = [{ rel: "a.md", path: "a" }];
    const content = () => "alpha\nBETA\ngamma beta\n";
    expect(searchNotes(notes, content, "beta").results.map((r) => r.line)).toEqual([2, 3]);
    expect(searchNotes(notes, content, "^gamma", { regex: true }).results.map((r) => r.line)).toEqual([3]);
    expect(searchNotes(notes, content, "a", { limit: 1 })).toMatchObject({ truncated: true });
    expect(searchNotes(notes, content, "(", { regex: true }).error).toContain("bad regex");
  });

  it("noteRelForTitle keeps spaces, strips hostile chars, refuses traversal", () => {
    expect(noteRelForTitle("My Note", "")).toBe("My Note.md"); // spaces are fine in note titles
    expect(noteRelForTitle("a?b*c", "")).toBe("abc.md"); // filesystem-hostile chars stripped
    expect(noteRelForTitle("Note", "Journal/Daily")).toBe("Journal/Daily/Note.md");
    expect(noteRelForTitle("../evil", "")).toBeNull();
    expect(noteRelForTitle("ok", "../../etc")).toBeNull();
  });

  it("openUri encodes the vault and note", () => {
    expect(openUri("/my vault", "A B.md")).toBe("basalt://open?vault=%2Fmy%20vault&note=A%20B.md");
  });
});

describe("cli run()", () => {
  it("ls lists notes (text + json)", () => {
    const t = makeIo(VAULT, FILES);
    expect(run(["ls"], t.io)).toBe(0);
    expect(t.out[0].split("\n")).toEqual(["Index.md", "Journal/2026-07-05.md", "Projects/Basalt.md"]);
    const j = makeIo(VAULT, FILES);
    run(["ls", "--json"], j.io);
    expect(JSON.parse(j.out[0])).toContain("Projects/Basalt.md");
  });

  it("cat prints content; a miss exits 1", () => {
    const t = makeIo(VAULT, FILES);
    expect(run(["cat", "Basalt"], t.io)).toBe(0);
    expect(t.out[0]).toContain("Anti-enshittification");
    const m = makeIo(VAULT, FILES);
    expect(run(["cat", "ghost"], m.io)).toBe(1);
    expect(m.err[0]).toContain("not found");
  });

  it("search prints rel:line: text", () => {
    const t = makeIo(VAULT, FILES);
    run(["search", "API"], t.io);
    expect(t.out).toEqual(["Journal/2026-07-05.md:2: Met Alice about the API."]);
  });

  it("new creates a note, refuses to overwrite, and can --open", () => {
    const t = makeIo(VAULT, FILES);
    expect(run(["new", "Fresh Idea", "--folder", "Notes"], t.io)).toBe(0);
    expect(t.out[0]).toBe("Notes/Fresh Idea.md");
    expect(t.store["/v/Notes/Fresh Idea.md"]).toBe("# Fresh Idea\n");
    // second attempt refuses
    expect(run(["new", "Fresh Idea", "--folder", "Notes"], t.io)).toBe(1);
    expect(t.err.join("")).toContain("Already exists");
    // --open hands off a basalt:// URI
    const o = makeIo(VAULT, FILES);
    run(["new", "Linked", "--content", "hi", "--open"], o.io);
    expect(o.store["/v/Linked.md"]).toBe("hi");
    expect(o.opened[0]).toContain("basalt://open?vault=");
  });

  it("expands a leading ~ in --vault/$BASALT_VAULT (quoted paths)", () => {
    const t = makeIo("/home/me/vault", { "/home/me/vault/Note.md": "hi" }, { HOME: "/home/me", BASALT_VAULT: "~/vault" });
    t.io.isDir = (p: string) => p === "/home/me/vault";
    expect(run(["ls"], t.io)).toBe(0);
    expect(t.out[0]).toBe("Note.md"); // "~/vault" resolved to /home/me/vault
  });

  it("no vault → error exit 1; help → 0", () => {
    const t = makeIo("", {}, { BASALT_VAULT: "" });
    t.io.cwd = "/nope";
    t.io.fileExists = () => false;
    expect(run(["ls"], t.io)).toBe(1);
    expect(run(["--help"], t.io)).toBe(0);
  });
});

describe("cli binary (end-to-end)", () => {
  it("runs against a real temp vault: ls, cat, new, search", () => {
    const dir = mkdtempSync(join(tmpdir(), "basalt-cli-"));
    try {
      mkdirSync(join(dir, ".obsidian"));
      mkdirSync(join(dir, "Journal"));
      writeFileSync(join(dir, "Journal", "2026-07-12.md"), "# Today\nremember the milk\n");
      const bin = (args: string[]) => execFileSync("node", [BIN, ...args, "--vault", dir], { encoding: "utf8" });

      expect(bin(["ls"]).trim()).toBe("Journal/2026-07-12.md");
      expect(bin(["cat", "2026-07-12"])).toContain("remember the milk");
      expect(bin(["search", "milk"]).trim()).toBe("Journal/2026-07-12.md:2: remember the milk");
      expect(bin(["new", "Scratch"]).trim()).toBe("Scratch.md");
      expect(existsSync(join(dir, "Scratch.md"))).toBe(true);
      expect(readFileSync(join(dir, "Scratch.md"), "utf8")).toBe("# Scratch\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
