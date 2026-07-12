// basalt CLI — pure core. All IO is injected via `io` so this is unit-testable
// without touching the filesystem. `cli/basalt.mjs` supplies the real io.
//
// io: {
//   cwd: string,
//   env: Record<string,string>,
//   fileExists(path): boolean,
//   isDir(path): boolean,
//   listMarkdown(vaultRoot): { rel, path }[],   // recursive, skips dotfolders
//   readFile(path): string,
//   writeFile(path, content): void,             // creates parent dirs
//   openUri(uri): void,
//   out(text): void,                            // stdout (adds newline)
//   err(text): void,                            // stderr (adds newline)
// }

const VALUE_FLAGS = new Set(["vault", "limit", "folder", "content"]);

export function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (VALUE_FLAGS.has(key)) {
          opts[key] = argv[++i];
        } else {
          opts[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], args: positional.slice(1), opts };
}

// Walk up from startDir looking for a vault marker (.obsidian or .basalt).
export function findVaultRoot(startDir, io) {
  let dir = startDir;
  while (dir) {
    if (io.fileExists(dir + "/.obsidian") || io.fileExists(dir + "/.basalt")) return dir;
    const parent = dir.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
    if (parent === dir || parent === "") return io.fileExists("/.obsidian") ? "/" : null;
    dir = parent;
  }
  return null;
}

function resolveVault(opts, io) {
  const explicit = opts.vault || io.env.BASALT_VAULT;
  if (explicit) return explicit.replace(/\/+$/, "");
  return findVaultRoot(io.cwd, io);
}

const stripMd = (s) => s.replace(/\.md$/i, "");

// Resolve a note query to one { rel, path } (exact rel → exact basename →
// case-insensitive contains). Returns null if nothing matches.
export function resolveNote(notes, query) {
  if (!query) return null;
  const q = stripMd(query);
  const ql = q.toLowerCase();
  const exactRel = notes.find((n) => stripMd(n.rel) === q);
  if (exactRel) return exactRel;
  const base = (n) => stripMd(n.rel.split("/").pop());
  const exactBase = notes.find((n) => base(n) === q);
  if (exactBase) return exactBase;
  const ciBase = notes.find((n) => base(n).toLowerCase() === ql);
  if (ciBase) return ciBase;
  return notes.find((n) => n.rel.toLowerCase().includes(ql)) || null;
}

// grep-like search across note bodies. Returns matches (rel, line, text),
// note-grouped, capped at `limit`. `regex` uses a case-insensitive RegExp.
export function searchNotes(notes, contentOf, query, { limit = 20, regex = false } = {}) {
  const results = [];
  let test;
  if (regex) {
    let re;
    try {
      re = new RegExp(query, "i");
    } catch (e) {
      return { error: `bad regex: ${e.message}`, results: [] };
    }
    test = (line) => re.test(line);
  } else {
    const ql = query.toLowerCase();
    test = (line) => line.toLowerCase().includes(ql);
  }
  for (const n of notes) {
    const lines = String(contentOf(n) || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (test(lines[i])) {
        results.push({ rel: n.rel, line: i + 1, text: lines[i].trim() });
        if (results.length >= limit) return { results, truncated: true };
      }
    }
  }
  return { results, truncated: false };
}

// Vault-relative path for a new note. Rejects path traversal; keeps subfolders
// in the title, sanitizes filesystem-hostile characters.
export function noteRelForTitle(title, folder) {
  const clean = (s) =>
    String(s)
      .replace(/[<>:"\\|?*]/g, "")
      .split("")
      .filter((c) => c.charCodeAt(0) >= 32)
      .join("")
      .replace(/\/{2,}/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .trim();
  const f = clean(folder || "");
  let t = clean(stripMd(title));
  if (!t || t.split("/").some((seg) => seg === "..")) return null;
  const rel = (f ? f + "/" : "") + t + ".md";
  if (rel.split("/").some((seg) => seg === "..")) return null;
  return rel;
}

const USAGE = `basalt — command-line access to a Basalt/Obsidian vault

Usage: basalt <command> [options]

Commands:
  ls                          List every note (relative paths)
  cat <note>                  Print a note's content
  path <note>                 Print a note's absolute path
  search <query>              Search note bodies (grep-like)
  new <title>                 Create a note (fails if it exists)
  open <note>                 Open the note in the Basalt app
  info                        Show the resolved vault and note count

Options:
  --vault <path>   Vault root (else $BASALT_VAULT, else walk up for .obsidian/.basalt)
  --json           Machine-readable output (ls / search / info)
  --limit <n>      Max search matches (default 20)
  --regex          Treat the search query as a case-insensitive regex
  --folder <path>  Subfolder for 'new'
  --content <str>  Body for 'new' (default: "# <title>")
  --force          Overwrite an existing note in 'new'
  --open           After 'new', open it in the app
  -h, --help       This help`;

export function run(argv, io) {
  const { command, args, opts } = parseArgs(argv);
  if (!command || opts.help || opts.h || command === "help") {
    io.out(USAGE);
    return 0;
  }

  const vault = resolveVault(opts, io);
  if (command === "info" && !vault) {
    io.err("No vault found. Pass --vault <path> or set $BASALT_VAULT.");
    return 1;
  }
  if (!vault) {
    io.err("No vault found. Pass --vault <path>, set $BASALT_VAULT, or run inside a vault.");
    return 1;
  }
  if (!io.isDir(vault)) {
    io.err(`Not a directory: ${vault}`);
    return 1;
  }

  const notes = io.listMarkdown(vault);

  switch (command) {
    case "info": {
      if (opts.json) io.out(JSON.stringify({ vault, notes: notes.length }));
      else io.out(`${vault}\n${notes.length} notes`);
      return 0;
    }
    case "ls": {
      const rels = notes.map((n) => n.rel).sort((a, b) => a.localeCompare(b));
      io.out(opts.json ? JSON.stringify(rels) : rels.join("\n"));
      return 0;
    }
    case "cat": {
      const note = resolveNote(notes, args[0]);
      if (!note) {
        io.err(`Note not found: ${args[0] ?? ""}`);
        return 1;
      }
      io.out(io.readFile(note.path));
      return 0;
    }
    case "path": {
      const note = resolveNote(notes, args[0]);
      if (!note) {
        io.err(`Note not found: ${args[0] ?? ""}`);
        return 1;
      }
      io.out(note.path);
      return 0;
    }
    case "search": {
      const query = args.join(" ");
      if (!query) {
        io.err("Usage: basalt search <query>");
        return 1;
      }
      const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
      const { results, truncated, error } = searchNotes(notes, (n) => io.readFile(n.path), query, { limit, regex: !!opts.regex });
      if (error) {
        io.err(error);
        return 1;
      }
      if (opts.json) {
        io.out(JSON.stringify({ results, truncated }));
      } else {
        for (const r of results) io.out(`${r.rel}:${r.line}: ${r.text}`);
        if (truncated) io.err(`… more than ${limit} matches; narrow the query or raise --limit.`);
        if (results.length === 0) io.err("No matches.");
      }
      return 0;
    }
    case "new": {
      const rel = noteRelForTitle(args.join(" "), opts.folder);
      if (!rel) {
        io.err(`Invalid title: ${args.join(" ")}`);
        return 1;
      }
      const abs = vault + "/" + rel;
      if (io.fileExists(abs) && !opts.force) {
        io.err(`Already exists: ${rel} (use --force to overwrite)`);
        return 1;
      }
      const body = opts.content != null && opts.content !== true ? String(opts.content) : `# ${stripMd(args.join(" "))}\n`;
      io.writeFile(abs, body);
      io.out(rel);
      if (opts.open) io.openUri(openUri(vault, rel));
      return 0;
    }
    case "open": {
      const note = resolveNote(notes, args[0]);
      const rel = note ? note.rel : args[0];
      if (!rel) {
        io.err("Usage: basalt open <note>");
        return 1;
      }
      io.openUri(openUri(vault, rel));
      return 0;
    }
    default:
      io.err(`Unknown command: ${command}\nRun 'basalt --help'.`);
      return 1;
  }
}

export function openUri(vault, rel) {
  return `basalt://open?vault=${encodeURIComponent(vault)}&note=${encodeURIComponent(rel)}`;
}
