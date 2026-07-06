// Full-text search over the in-memory vault (the index already holds every
// note's content, so no Rust round-trip is needed). Case/Unicode-insensitive
// (NFC-normalized — NFD filenames/content are routine on macOS), ranked before
// truncation so the cap can't hide better matches.
//
// Operators (Obsidian-like): `path:x` / `file:x` / `tag:x` scope by rel /
// filename / tag; `-term` excludes; `"a phrase"` matches literally; `/re/flags`
// searches by regex. Bare terms are AND-ed (all must appear in the note).
import type { VaultNote } from "./vault";
import { looksCatastrophic } from "./bases";

export interface SearchHit {
  path: string;
  name: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line, trimmed, for display. */
  lineText: string;
}

export interface SearchOpts {
  /** A note's tags (bare, no `#`) — for the `tag:` operator. */
  tagsOf?: (path: string) => string[];
}

const MAX_HITS = 300;
const MAX_HITS_PER_NOTE = 20;
const MAX_REGEX_LINE = 5000; // don't run a user regex over a pathological line

const norm = (s: string) => s.normalize("NFC").toLowerCase();

const lineCache = new WeakMap<VaultNote, string[]>();
function normLines(note: VaultNote): string[] {
  let lines = lineCache.get(note);
  if (!lines) {
    lines = note.content.split("\n").map(norm);
    lineCache.set(note, lines);
  }
  return lines;
}

interface Query {
  terms: string[]; // AND, normalized substrings
  negations: string[];
  paths: string[];
  files: string[];
  tags: string[];
  regex: RegExp | null;
}

/** Split a query on spaces, keeping "quoted phrases" intact. */
function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

export function parseSearchQuery(query: string): Query {
  const q: Query = { terms: [], negations: [], paths: [], files: [], tags: [], regex: null };
  for (const tok of tokenize(query.trim())) {
    if (!tok) continue;
    const rx = /^\/(.+)\/([gimsuy]*)$/.exec(tok);
    if (rx && !q.regex && !looksCatastrophic(rx[1])) {
      try {
        q.regex = new RegExp(rx[1], rx[2].includes("i") ? rx[2] : rx[2] + "i");
        continue;
      } catch {
        /* not a valid regex — treat as a literal term below */
      }
    }
    const op = /^(-?)(path|file|tag):(.*)$/i.exec(tok);
    if (op && op[3]) {
      const val = norm(op[3]);
      const bucket = op[2].toLowerCase() === "path" ? q.paths : op[2].toLowerCase() === "file" ? q.files : q.tags;
      bucket.push(op[2].toLowerCase() === "tag" ? val.replace(/^#/, "") : val);
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) q.negations.push(norm(tok.slice(1)));
    else q.terms.push(norm(tok));
  }
  return q;
}

function noteMatchesFilters(note: VaultNote, q: Query, opts: SearchOpts): boolean {
  const rel = norm(note.rel);
  if (!q.paths.every((p) => rel.includes(p))) return false;
  const nm = norm(note.name);
  if (!q.files.every((f) => nm.includes(f))) return false;
  if (q.tags.length) {
    const tags = (opts.tagsOf?.(note.path) ?? []).map(norm);
    if (!q.tags.every((t) => tags.some((nt) => nt === t || nt.startsWith(t + "/")))) return false;
  }
  return true;
}

export function searchVault(notes: VaultNote[], query: string, opts: SearchOpts = {}): SearchHit[] {
  const q = parseSearchQuery(query);
  const hasContentQuery = q.terms.length > 0 || q.regex !== null;
  const hasAny = hasContentQuery || q.paths.length || q.files.length || q.tags.length || q.negations.length;
  if (!hasAny) return [];

  const scored: { hit: SearchHit; score: number }[] = [];
  for (const note of notes) {
    if (!noteMatchesFilters(note, q, opts)) continue;
    const lines = normLines(note);
    const rawLines = note.content.split("\n");
    const noteText = lines.join("\n");

    // Note-level AND / NOT: every positive term must appear, no negation may.
    if (!q.terms.every((t) => noteText.includes(t))) continue;
    if (q.negations.some((n) => noteText.includes(n))) continue;

    // Title match ranks first.
    const nameHitIdx = q.terms.length ? norm(note.name).indexOf(q.terms[0]) : q.terms.length === 0 ? 0 : -1;
    if (nameHitIdx !== -1 && (q.terms.length > 0 || !hasContentQuery)) {
      scored.push({
        hit: { path: note.path, name: note.name, line: 1, lineText: note.name },
        score: 1000 - nameHitIdx - note.name.length * 0.01,
      });
    }

    // Line hits: a line matching the regex, or containing ANY positive term.
    let inNote = 0;
    for (let i = 0; i < lines.length && inNote < MAX_HITS_PER_NOTE; i++) {
      let idx = -1;
      if (q.regex) {
        if (rawLines[i].length <= MAX_REGEX_LINE) {
          q.regex.lastIndex = 0;
          const m = q.regex.exec(rawLines[i]);
          idx = m ? m.index : -1;
        }
      } else if (q.terms.length) {
        for (const t of q.terms) {
          const j = lines[i].indexOf(t);
          if (j !== -1 && (idx === -1 || j < idx)) idx = j;
        }
      }
      if (idx === -1) continue;
      scored.push({
        hit: { path: note.path, name: note.name, line: i + 1, lineText: rawLines[i].trim() },
        score: 100 - idx * 0.1 - i * 0.001,
      });
      inNote++;
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_HITS).map((s) => s.hit);
}
