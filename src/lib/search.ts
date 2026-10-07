// Full-text search over the in-memory vault (the index already holds every
// note's content, so no Rust round-trip is needed). Case/Unicode-insensitive
// (NFC-normalized — NFD filenames/content are routine on macOS), ranked before
// truncation so the cap can't hide better matches.
//
// Operators (Obsidian-like): `path:x` / `file:x` / `tag:x` scope by rel /
// filename / tag; `-term` excludes; `"a phrase"` matches literally; `/re/flags`
// searches by regex; `line:`, `section:` and `task:` (`task-todo:`,
// `task-done:`) keep terms on one line, under one heading or in one task;
// `[prop]` / `[prop:value]` look at the frontmatter; `match-case:` is
// case-sensitive; `OR` and `(a OR b)` give alternatives. Bare terms are AND-ed.
import type { VaultNote } from "./vault";
import { looksCatastrophic, parseProperties } from "./bases";

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
/** The most hits a search returns. */
export const SEARCH_MAX_HITS = MAX_HITS;
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
  /** `-path:` / `-file:` / `-tag:` exclusions. */
  notPaths: string[];
  notFiles: string[];
  notTags: string[];
  regex: RegExp | null;
  /** `line:(a b)` groups — each inner array's terms must all appear on ONE line. */
  lineGroups: string[][];
  /** `task:` groups: all terms in one task, of any status, open or done. */
  taskGroups: { terms: string[]; status: "any" | "todo" | "done" }[];
  /** `section:` groups: all terms under one heading. */
  sectionGroups: string[][];
  /** `[prop]` / `[prop:value]`. */
  props: { key: string; value: string | null }[];
  /** `match-case:` terms, matched as written. */
  caseTerms: string[];
  /** `(a OR b)` groups: one of each must appear. */
  anyOf: string[][];
}

// `line:(a b)` (same-line group) or `line:word` (single term on a line).
const LINE_RE = /line:\(([^)]*)\)|line:(\S+)/gi;

/** Pull `line:(…)` clauses out of a group string into same-line term groups,
 * returning the remaining query text (they can't survive plain tokenizing —
 * the parens hold spaces). */
function extractLineGroups(s: string, unkeep: (t: string) => string = (t) => t): { lineGroups: string[][]; rest: string } {
  const lineGroups: string[][] = [];
  const rest = s.replace(LINE_RE, (_m, paren?: string, single?: string) => {
    const body = paren !== undefined ? paren : (single ?? "");
    const terms = body.split(/\s+/).map(unkeep).map(norm).filter(Boolean);
    if (terms.length) lineGroups.push(terms);
    return " ";
  });
  return { lineGroups, rest };
}

// `task:(a b)`, `task-todo:word`, `section:"a phrase"`…
const SCOPED_RE = /(task|task-todo|task-done|section):(?:\(([^)]*)\)|"([^"]*)"|(\S+))/gi;
const PROP_RE = /\[([^\]:\n]+)(?::([^\]\n]*))?\]/g;
const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]\n])\]/;
const HEADING = /^#{1,6}\s/;
const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1");

/** Pull `task:`, `section:`, `[prop]` and `(a OR b)` clauses out of a group. */
function extractScoped(s: string, q: Query, unkeep: (t: string) => string = (t) => t): string {
  let rest = s.replace(SCOPED_RE, (_m, op: string, paren?: string, quoted?: string, single?: string) => {
    const terms = paren !== undefined ? tokenize(paren).map(unkeep).map(norm) : [norm(unkeep(quoted ?? single ?? ""))];
    const kept = terms.filter(Boolean);
    if (!kept.length) return " ";
    const kind = op.toLowerCase();
    if (kind === "section") q.sectionGroups.push(kept);
    else q.taskGroups.push({ terms: kept, status: kind === "task-todo" ? "todo" : kind === "task-done" ? "done" : "any" });
    return " ";
  });
  rest = rest.replace(PROP_RE, (_m, key: string, value?: string) => {
    q.props.push({ key: norm(key.trim()), value: value === undefined ? null : norm(unquote(value)) });
    return " ";
  });
  // `(a OR b)`: alternatives; a group without OR is just its terms.
  rest = rest.replace(/\(([^()]*)\)/g, (_m, body: string) => {
    const alts = splitOnOr(body).map((a) => norm(unquote(unkeep(a.trim())))).filter(Boolean);
    if (alts.length > 1) {
      q.anyOf.push(alts);
      return " ";
    }
    return ` ${body} `;
  });
  return rest;
}

/** Split a query on spaces, keeping "quoted phrases" intact. */
function tokenize(q: string): string[] {
  const out: string[] = [];
  // A quoted phrase (an operator's quoted value stays one token with it), a
  // /regex/ that may hold spaces, or a run of non-space.
  const re = /(-?[a-z]+:)?"([^"]*)"|(\/(?:\\.|[^/\\\n])+\/[gimsuy]*)(?=\s|$)|(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[2] !== undefined ? (m[1] ?? "") + m[2] : (m[3] ?? m[4]));
  return out;
}

/** Split a query into OR-groups at a top-level, unquoted ` OR ` (Obsidian's
 * uppercase OR keyword), outside parentheses. `A B OR C D` → ["A B", "C D"]. */
function splitOnOr(query: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === '"') {
      inQuote = !inQuote;
      cur += c;
    } else if (!inQuote && (c === "(" || c === ")")) {
      depth = Math.max(0, depth + (c === "(" ? 1 : -1));
      cur += c;
    } else if (!inQuote && depth === 0 && query.startsWith(" OR ", i)) {
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

// A /regex/, a standalone "phrase" or a [[link]] holds brackets the clause
// extractors would take apart, so each is set aside until tokenizing.
const KEEP_RE = /(?<=^|\s)(?:\/(?:\\.|[^/\\\n])+\/[gimsuy]*|"[^"]*"|\[\[[^\]\n]*\]\])(?=\s|$)/g;
const KEPT_RE = /^\u0001(\d+)\u0001$/;

function buildQuery(groupStr: string): Query {
  const kept: string[] = [];
  const masked = groupStr.replace(KEEP_RE, (m) => `\u0001${kept.push(m) - 1}\u0001`);
  // A set-aside phrase inside a clause's group comes back as one term.
  const unkeep = (t: string) => {
    const k = KEPT_RE.exec(t);
    return k ? (tokenize(kept[Number(k[1])])[0] ?? t) : t;
  };
  const { lineGroups, rest: afterLines } = extractLineGroups(masked, unkeep);
  const q: Query = {
    terms: [], negations: [], paths: [], files: [], tags: [], notPaths: [], notFiles: [], notTags: [], regex: null, lineGroups,
    taskGroups: [], sectionGroups: [], props: [], caseTerms: [], anyOf: [],
  };
  const rest = extractScoped(afterLines, q, unkeep);
  const tokens = tokenize(rest).flatMap((t) => {
    const k = KEPT_RE.exec(t);
    return k ? tokenize(kept[Number(k[1])]) : [t];
  });
  for (const tok of tokens) {
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
    const cs = /^match-case:(.+)$/i.exec(tok);
    if (cs) {
      q.caseTerms.push(cs[1].normalize("NFC"));
      continue;
    }
    if (/^ignore-case:./i.test(tok)) {
      q.terms.push(norm(tok.slice(tok.indexOf(":") + 1)));
      continue;
    }
    const op = /^(-?)(path|file|tag):(.*)$/i.exec(tok);
    if (op && op[3]) {
      const val = norm(op[3]);
      const kind = op[2].toLowerCase();
      const not = op[1] === "-";
      const bucket =
        kind === "path" ? (not ? q.notPaths : q.paths) : kind === "file" ? (not ? q.notFiles : q.files) : not ? q.notTags : q.tags;
      bucket.push(kind === "tag" ? val.replace(/^#/, "") : val);
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

// A note's frontmatter as lowercase keys and searchable text, read once.
const propCache = new WeakMap<VaultNote, Map<string, string>>();
function propsOf(note: VaultNote): Map<string, string> {
  let props = propCache.get(note);
  if (!props) {
    props = new Map();
    for (const [k, v] of Object.entries(parseProperties(note.content))) {
      props.set(norm(k), norm(Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v)));
    }
    propCache.set(note, props);
  }
  return props;
}

/** Indices of `lines` where each heading's section starts (0 first). */
function sectionStarts(lines: string[]): number[] {
  const out = [0];
  lines.forEach((l, i) => {
    if (i > 0 && HEADING.test(l)) out.push(i);
  });
  return out;
}

const taskStatusOk = (line: string, status: "any" | "todo" | "done") => {
  const m = TASK_LINE.exec(line);
  if (!m) return false;
  return status === "any" || (status === "todo") === (m[1] === " ");
};

function noteMatchesFilters(note: VaultNote, q: Query, opts: SearchOpts): boolean {
  const rel = norm(note.rel);
  if (!q.paths.every((p) => rel.includes(p))) return false;
  if (q.notPaths.some((p) => rel.includes(p))) return false;
  const nm = norm(note.name);
  if (!q.files.every((f) => nm.includes(f))) return false;
  if (q.notFiles.some((f) => nm.includes(f))) return false;
  if (q.tags.length || q.notTags.length) {
    const tags = (opts.tagsOf?.(note.path) ?? []).map(norm);
    const has = (t: string) => tags.some((nt) => nt === t || nt.startsWith(t + "/"));
    if (!q.tags.every(has)) return false;
    if (q.notTags.some(has)) return false;
  }
  if (q.props.length) {
    const props = propsOf(note);
    if (!q.props.every((p) => props.has(p.key) && (p.value === null || props.get(p.key)!.includes(p.value)))) return false;
  }
  return true;
}

/** Whether a group has anything to match on. */
function groupHasContent(q: Query): boolean {
  return (
    q.terms.length > 0 ||
    q.regex !== null ||
    q.lineGroups.length > 0 ||
    q.taskGroups.length > 0 ||
    q.sectionGroups.length > 0 ||
    q.caseTerms.length > 0 ||
    q.anyOf.length > 0
  );
}
function groupHasAny(q: Query): boolean {
  return (
    groupHasContent(q) ||
    !!(q.paths.length || q.files.length || q.tags.length || q.negations.length || q.notPaths.length || q.notFiles.length || q.notTags.length || q.props.length)
  );
}
/** A note satisfies a group's note-level filters + AND-terms + no-negation +
 * every `line:` group being satisfiable by some single line. */
function noteMatchesGroup(note: VaultNote, q: Query, noteText: string, lines: string[], opts: SearchOpts): boolean {
  if (!noteMatchesFilters(note, q, opts)) return false;
  if (!q.terms.every((t) => noteText.includes(t))) return false;
  if (q.negations.some((n) => noteText.includes(n))) return false;
  if (!q.lineGroups.every((lg) => lines.some((line) => lg.every((t) => line.includes(t))))) return false;
  if (!q.anyOf.every((alts) => alts.some((a) => noteText.includes(a)))) return false;
  if (q.caseTerms.length) {
    const raw = note.content.normalize("NFC");
    if (!q.caseTerms.every((t) => raw.includes(t))) return false;
  }
  if (!q.taskGroups.every((tg) => lines.some((l) => taskStatusOk(l, tg.status) && tg.terms.every((t) => l.includes(t))))) return false;
  if (q.sectionGroups.length) {
    const starts = sectionStarts(lines);
    const sections = starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length).join("\n"));
    if (!q.sectionGroups.every((sg) => sections.some((sec) => sg.every((t) => sec.includes(t))))) return false;
  }
  return true;
}

/** The best `SEARCH_MAX_HITS` results, with how many results there were in
 * all and in how many notes. */
export type SearchResults = SearchHit[] & { total: number; notes: number };

export function searchVault(notes: VaultNote[], query: string, opts: SearchOpts = {}): SearchResults {
  const groups = parseSearchGroups(query).filter(groupHasAny);
  if (groups.length === 0) return Object.assign([], { total: 0, notes: 0 });
  const anyContent = groups.some(groupHasContent);

  const scored: { hit: SearchHit; score: number }[] = [];
  let unlisted = 0; // matching lines past a note's cap: counted, not listed
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
    // Past the lines a note lists, plain terms and regexes are only counted,
    // quickly, the way the loop below finds them.
    const plain = matched.every((g) => !g.lineGroups.length && !g.taskGroups.length && !g.sectionGroups.length && !g.anyOf.length && !g.caseTerms.length);
    const hits = (i: number) =>
      matched.some((g) => {
        if (!g.regex) return g.terms.some((t) => lines[i].includes(t));
        if (rawLines[i].length > MAX_REGEX_LINE) return false;
        g.regex.lastIndex = 0;
        return g.regex.test(rawLines[i]);
      });
    for (let i = 0; i < lines.length; i++) {
      if (inNote >= MAX_HITS_PER_NOTE && plain) {
        for (; i < lines.length; i++) if (hits(i)) unlisted++;
        break;
      }
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
        // A `line:(…)` group hits the lines where all its terms co-occur, and
        // a `task:` group the tasks holding all of its.
        for (const lg of g.lineGroups) {
          if (lg.every((t) => lines[i].includes(t))) {
            const j = Math.min(...lg.map((t) => lines[i].indexOf(t)));
            if (idx === -1 || j < idx) idx = j;
          }
        }
        for (const tg of g.taskGroups) {
          if (taskStatusOk(lines[i], tg.status) && tg.terms.every((t) => lines[i].includes(t))) {
            const j = Math.min(...tg.terms.map((t) => lines[i].indexOf(t)));
            if (idx === -1 || j < idx) idx = j;
          }
        }
        // Section terms, alternatives and case-sensitive terms hit where they appear.
        for (const t of [...g.sectionGroups.flat(), ...g.anyOf.flat()]) {
          const j = lines[i].indexOf(t);
          if (j !== -1 && (idx === -1 || j < idx)) idx = j;
        }
        for (const t of g.caseTerms) {
          const j = rawLines[i].indexOf(t);
          if (j !== -1 && (idx === -1 || j < idx)) idx = j;
        }
      }
      if (idx === -1 || seenLine.has(i)) continue;
      seenLine.add(i);
      if (inNote >= MAX_HITS_PER_NOTE) {
        unlisted++;
        continue;
      }
      scored.push({
        hit: { path: note.path, name: note.name, line: i + 1, lineText: rawLines[i].trim() },
        score: 100 - idx * 0.1 - i * 0.001,
      });
      inNote++;
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.slice(0, MAX_HITS).map((s) => s.hit);
  return Object.assign(best, { total: scored.length + unlisted, notes: new Set(scored.map((s) => s.hit.path)).size });
}
