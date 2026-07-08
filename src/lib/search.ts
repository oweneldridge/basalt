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
  /** `line:(a b)` groups — each inner array's terms must all appear on ONE line. */
  lineGroups: string[][];
}

// `line:(a b)` (same-line group) or `line:word` (single term on a line).
const LINE_RE = /line:\(([^)]*)\)|line:(\S+)/gi;

/** Pull `line:(…)` clauses out of a group string into same-line term groups,
 * returning the remaining query text (they can't survive plain tokenizing —
 * the parens hold spaces). */
function extractLineGroups(s: string): { lineGroups: string[][]; rest: string } {
  const lineGroups: string[][] = [];
  const rest = s.replace(LINE_RE, (_m, paren?: string, single?: string) => {
    const body = paren !== undefined ? paren : (single ?? "");
    const terms = body.split(/\s+/).map(norm).filter(Boolean);
    if (terms.length) lineGroups.push(terms);
    return " ";
  });
  return { lineGroups, rest };
}

/** Split a query on spaces, keeping "quoted phrases" intact. */
function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** Split a query into OR-groups at a top-level, unquoted ` OR ` (Obsidian's
 * uppercase OR keyword). `A B OR C D` → ["A B", "C D"]. */
function splitOnOr(query: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === '"') {
      inQuote = !inQuote;
      cur += c;
    } else if (!inQuote && query.startsWith(" OR ", i)) {
      parts.push(cur);
      cur = "";
      i += 3; // skip "OR " (the leading space was consumed)
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function buildQuery(groupStr: string): Query {
  const { lineGroups, rest } = extractLineGroups(groupStr);
  const q: Query = { terms: [], negations: [], paths: [], files: [], tags: [], regex: null, lineGroups };
  for (const tok of tokenize(rest)) {
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

/** Parse a query into one Query per top-level OR-group. */
export function parseSearchQuery(query: string): Query {
  return buildQuery(query.trim());
}
export function parseSearchGroups(query: string): Query[] {
  return splitOnOr(query.trim()).map(buildQuery);
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

/** Whether a group has anything to match on. */
function groupHasContent(q: Query): boolean {
  return q.terms.length > 0 || q.regex !== null || q.lineGroups.length > 0;
}
function groupHasAny(q: Query): boolean {
  return groupHasContent(q) || !!(q.paths.length || q.files.length || q.tags.length || q.negations.length);
}
/** A note satisfies a group's note-level filters + AND-terms + no-negation +
 * every `line:` group being satisfiable by some single line. */
function noteMatchesGroup(note: VaultNote, q: Query, noteText: string, lines: string[], opts: SearchOpts): boolean {
  if (!noteMatchesFilters(note, q, opts)) return false;
  if (!q.terms.every((t) => noteText.includes(t))) return false;
  if (q.negations.some((n) => noteText.includes(n))) return false;
  if (!q.lineGroups.every((lg) => lines.some((line) => lg.every((t) => line.includes(t))))) return false;
  return true;
}

export function searchVault(notes: VaultNote[], query: string, opts: SearchOpts = {}): SearchHit[] {
  const groups = parseSearchGroups(query).filter(groupHasAny);
  if (groups.length === 0) return [];
  const anyContent = groups.some(groupHasContent);

  const scored: { hit: SearchHit; score: number }[] = [];
  for (const note of notes) {
    const lines = normLines(note);
    const rawLines = note.content.split("\n");
    const noteText = lines.join("\n");
    // The groups this note satisfies (OR: any is enough).
    const matched = groups.filter((g) => noteMatchesGroup(note, g, noteText, lines, opts));
    if (matched.length === 0) continue;

    // Title match ranks first (use the first positive term of any matched group).
    const firstTerm = matched.map((g) => g.terms[0]).find((t) => t !== undefined);
    const nameHitIdx = firstTerm ? norm(note.name).indexOf(firstTerm) : anyContent ? -1 : 0;
    if (nameHitIdx !== -1 && (firstTerm !== undefined || !anyContent)) {
      scored.push({
        hit: { path: note.path, name: note.name, line: 1, lineText: note.name },
        score: 1000 - nameHitIdx - note.name.length * 0.01,
      });
    }

    // Line hits: a line matching ANY matched group's regex or positive terms.
    const seenLine = new Set<number>();
    let inNote = 0;
    for (let i = 0; i < lines.length && inNote < MAX_HITS_PER_NOTE; i++) {
      let idx = -1;
      for (const g of matched) {
        if (g.regex) {
          if (rawLines[i].length <= MAX_REGEX_LINE) {
            g.regex.lastIndex = 0;
            const m = g.regex.exec(rawLines[i]);
            if (m && (idx === -1 || m.index < idx)) idx = m.index;
          }
        } else {
          for (const t of g.terms) {
            const j = lines[i].indexOf(t);
            if (j !== -1 && (idx === -1 || j < idx)) idx = j;
          }
        }
        // A `line:(…)` group hits the lines where all its terms co-occur.
        for (const lg of g.lineGroups) {
          if (lg.every((t) => lines[i].includes(t))) {
            const j = Math.min(...lg.map((t) => lines[i].indexOf(t)));
            if (idx === -1 || j < idx) idx = j;
          }
        }
      }
      if (idx === -1 || seenLine.has(i)) continue;
      seenLine.add(i);
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
