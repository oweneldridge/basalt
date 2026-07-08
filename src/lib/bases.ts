// Obsidian Bases (.base) — a read-only engine for the YAML view format
// (help.obsidian.md/bases). PURE: rows in → filtered/sorted/grouped view out,
// so the whole expression language is unit-testable without Tauri.
//
// Tolerance contract (mirrors lib/canvas.ts): parseBase returns null only when
// the YAML itself is unparseable; malformed sections are dropped. A filter or
// formula that fails to parse/evaluate yields false/null for that row — one
// bad expression must never blank a whole view. Runaway expressions (deep
// nesting, huge map/reduce) are cut off by parse-depth and eval-step budgets.

import * as YAML from "yaml";
import { formatMoment, UnsupportedTokenError } from "./daily";

// ---------------------------------------------------------------------------
// Rows: what a .base evaluates over (one per vault file).

/** One vault file as Bases sees it. `properties` is the YAML-parsed
 * frontmatter (typed values, not strings); `tags` are lowercase without '#';
 * `linkKeys` are lowercase match keys for hasLink (raw targets, resolved
 * rels, and basenames, with and without .md). */
export interface BaseRow {
  name: string; // filename with extension
  basename: string;
  path: string; // vault-relative
  folder: string; // parent folder ("" at root)
  ext: string;
  size: number;
  ctime: number; // ms epoch, 0 = unknown
  mtime: number;
  tags: string[];
  linkKeys: string[];
  properties: Record<string, unknown>;
}

/** YAML-parse a note's frontmatter into typed property values. Returns {} for
 * no frontmatter or malformed YAML — Bases never hard-fails on one note. */
export function parseProperties(source: string): Record<string, unknown> {
  const src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source; // strip BOM
  if (!src.startsWith("---")) return {};
  const lines = src.split("\n");
  // Fence lines may carry trailing whitespace (`--- ` / `... `) — don't let it
  // drop the whole frontmatter.
  if (!/^---\s*$/.test(lines[0].replace(/\r$/, ""))) return {};
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, "");
    if (/^(---|\.\.\.)\s*$/.test(l)) {
      close = i;
      break;
    }
  }
  if (close < 0) return {};
  try {
    const v: unknown = YAML.parse(
      lines
        .slice(1, close)
        .map((l) => l.replace(/\r$/, "")) // CRLF vaults: \r must not leak into values
        .join("\n"),
    );
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Base definition (the parsed .base file).

export type FilterNode =
  | string
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode[] };

export interface SortSpec {
  property: string;
  direction: "ASC" | "DESC";
}

export interface BaseViewDef {
  type: string; // "table" | "cards" | anything (unknown renders as table)
  name: string;
  limit?: number;
  filters?: FilterNode;
  order?: string[];
  sort?: SortSpec[];
  groupBy?: SortSpec;
  /** column key -> summary name or custom-summary key */
  summaries?: Record<string, string>;
  /** cards view: property whose value is the card image */
  image?: string;
  /** Original parsed view object — preserves unmodeled keys on save. */
  raw?: Record<string, unknown>;
}

export interface BaseDef {
  filters?: FilterNode;
  formulas: Record<string, string>;
  /** property key -> displayName */
  display: Record<string, string>;
  /** custom summary formulas (receive `values`) */
  summaries: Record<string, string>;
  views: BaseViewDef[];
  /** Original parsed root — everything Basalt's editor doesn't touch
   * (formulas, properties, top-level filters, unknown keys) round-trips
   * through here so a save never drops it. */
  raw?: Record<string, unknown>;
  /** The exact source text, so serializeBase can edit through a YAML Document
   * and preserve comments/formatting Basalt only rewrites the `views` of. */
  rawText?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function filterNode(v: unknown): FilterNode | undefined {
  if (typeof v === "string") return v;
  const r = asRecord(v);
  if (!r) return undefined;
  for (const k of ["and", "or", "not"] as const) {
    if (Array.isArray(r[k])) {
      const kids = (r[k] as unknown[]).map(filterNode).filter((x): x is FilterNode => x !== undefined);
      return { [k]: kids } as FilterNode;
    }
  }
  return undefined;
}

function sortSpec(v: unknown): SortSpec | undefined {
  if (typeof v === "string") return { property: v, direction: "ASC" };
  const r = asRecord(v);
  if (!r || typeof r.property !== "string") return undefined;
  const dir = String(r.direction ?? "ASC").toUpperCase();
  return { property: r.property, direction: dir === "DESC" ? "DESC" : "ASC" };
}

/** Parse a .base file. Null only if the YAML itself is unparseable; malformed
 * sections are dropped. Always yields at least one (default table) view. */
export function parseBase(text: string): BaseDef | null {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch {
    return null;
  }
  const root = asRecord(raw) ?? {};

  const formulas: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(root.formulas) ?? {})) {
    if (typeof v === "string") formulas[k] = v;
  }

  const display: Record<string, string> = {};
  // Obsidian has used both `properties: {k: {displayName}}` and `display: {k: name}`.
  for (const [k, v] of Object.entries(asRecord(root.properties) ?? {})) {
    const r = asRecord(v);
    if (r && typeof r.displayName === "string") display[k] = r.displayName;
    else if (typeof v === "string") display[k] = v;
  }
  for (const [k, v] of Object.entries(asRecord(root.display) ?? {})) {
    if (typeof v === "string") display[k] = v;
  }

  const summaries: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(root.summaries) ?? {})) {
    if (typeof v === "string") summaries[k] = v;
  }

  const views: BaseViewDef[] = [];
  for (const v of Array.isArray(root.views) ? root.views : []) {
    const r = asRecord(v);
    if (!r) continue;
    const viewSummaries: Record<string, string> = {};
    for (const [k, s] of Object.entries(asRecord(r.summaries) ?? {})) {
      if (typeof s === "string") viewSummaries[k] = s;
    }
    views.push({
      type: typeof r.type === "string" ? r.type : "table",
      name: typeof r.name === "string" ? r.name : "Table",
      limit: typeof r.limit === "number" && r.limit > 0 ? Math.floor(r.limit) : undefined,
      filters: filterNode(r.filters),
      order: Array.isArray(r.order) ? r.order.filter((x): x is string => typeof x === "string") : undefined,
      sort: Array.isArray(r.sort)
        ? r.sort.map(sortSpec).filter((x): x is SortSpec => x !== undefined)
        : undefined,
      groupBy: sortSpec(r.groupBy),
      summaries: Object.keys(viewSummaries).length ? viewSummaries : undefined,
      image: typeof r.image === "string" ? r.image : undefined,
      raw: r,
    });
  }
  if (views.length === 0) views.push({ type: "table", name: "Table" });

  return { filters: filterNode(root.filters), formulas, display, summaries, views, raw: root, rawText: text };
}

/** Rebuild the plain `views` array Basalt writes. Only the keys in Obsidian's
 * documented .base view schema (help.obsidian.md/bases/syntax) are written from
 * the model — `type`, `name`, `limit`, `order`, `image`, `groupBy`, and a
 * simple string `filters`; everything else round-trips through each view's
 * `raw`. Obsidian documents no per-view `sort` key, so we never emit one (a
 * legacy Basalt `sort` survives via raw). A nested/unchanged filter is left in
 * raw verbatim — only a simple string filter (the only kind the editor edits)
 * is re-written. */
function buildViews(def: BaseDef): Record<string, unknown>[] {
  const put = (o: Record<string, unknown>, k: string, v: unknown) => {
    if (v === undefined || v === null) delete o[k];
    else o[k] = v;
  };
  return def.views.map((v) => {
    const o: Record<string, unknown> = { ...(v.raw ?? {}) };
    o.type = v.type;
    o.name = v.name;
    put(o, "limit", v.limit);
    put(o, "order", v.order && v.order.length ? v.order : undefined);
    put(o, "image", v.image);
    // groupBy: { property, direction } — the documented Obsidian shape.
    put(o, "groupBy", v.groupBy ? { property: v.groupBy.property, direction: v.groupBy.direction } : undefined);
    // filters: rewrite only when it's a simple string (editable); a nested
    // and/or/not tree stays as raw (re-serializing the parsed FilterNode could
    // drop shapes filterNode() didn't model).
    if (typeof v.filters === "string") o.filters = v.filters;
    else if (v.filters === undefined) delete o.filters;
    return o;
  });
}

/** Serialize a BaseDef back to `.base` YAML. Basalt only edits VIEW-level
 * fields, so — to preserve comments, blank lines, and formatting on the live
 * shared file — it edits through a YAML Document and replaces ONLY the `views`
 * node; everything else (top-level filters, formulas, properties, comments)
 * stays exactly as authored. Falls back to a fresh stringify if the original
 * text isn't a usable YAML map. */
export function serializeBase(def: BaseDef): string {
  const views = buildViews(def);
  if (def.rawText !== undefined) {
    try {
      const doc = YAML.parseDocument(def.rawText);
      if (doc.errors.length === 0 && YAML.isMap(doc.contents)) {
        doc.set("views", views);
        return doc.toString();
      }
    } catch {
      /* fall through to a fresh serialize */
    }
  }
  return YAML.stringify({ ...(def.raw ?? {}), views });
}

// ---------------------------------------------------------------------------
// Values. Wrapped types are classes so evaluation can instanceof-dispatch.

export class DateVal {
  constructor(public ms: number) {}
}
export class DurVal {
  constructor(public ms: number) {}
}
export class LinkVal {
  constructor(
    public target: string,
    public display?: string,
  ) {}
}
export class FileVal {
  constructor(public row: BaseRow) {}
}
class RegexVal {
  constructor(public re: RegExp) {}
}
/** html()/image()/icon() results — the component decides how to render them
 * (html is shown as plain text: Basalt does not execute HTML from a .base). */
export class RenderVal {
  constructor(
    public kind: "html" | "image" | "icon",
    public value: string,
  ) {}
}

export type Val =
  | null
  | boolean
  | number
  | string
  | Val[]
  | DateVal
  | DurVal
  | LinkVal
  | FileVal
  | RegexVal
  | RenderVal
  | { [k: string]: unknown };

/** Convert a YAML frontmatter value to an expression value. A "[[Note]]"
 * string becomes a LinkVal so ==, linksTo, asFile and cell rendering all treat
 * it as a link (Obsidian does the same for wikilink-typed properties). */
function fromYaml(v: unknown): Val {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const wl = WIKILINK_RE.exec(v);
    return wl ? new LinkVal(wl[1], wl[2]) : v;
  }
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(fromYaml);
  if (v instanceof Date) return new DateVal(v.getTime()); // yaml pkg may emit Date for timestamps
  if (typeof v === "object") return v as Val;
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizer.

interface Tok {
  kind: "num" | "str" | "ident" | "op" | "regex" | "eof";
  text: string;
  num?: number;
  /** regex tokens: pattern body and flags, kept separate (a body may contain spaces) */
  body?: string;
  flags?: string;
}

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "."];

/** A frontmatter wikilink string like "[[Note]]" / "[[Note|alias]]". */
const WIKILINK_RE = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/;

class ExprError extends Error {}

/** Conservative static ReDoS guard. Rejects a quantifier applied to a group
 * that itself contains an unbounded quantifier — the classic exponential shape
 * `(a+)+`, `(a*)*`, `(a+|b+)*`, `(a{2,})+`, etc. This can't catch every
 * pathological pattern, but it stops the common catastrophic-backtracking forms
 * that would freeze the (single-threaded, non-interruptible) evaluator. False
 * positives only make a rare safe pattern unusable in a .base — acceptable for
 * a read-only viewer over untrusted files. */
export function looksCatastrophic(body: string): boolean {
  // Walk groups; for each group ending in an outer quantifier, check whether
  // the group body contains an unbounded quantifier not inside a char class.
  const stack: { start: number; classDepth: number; hasQuant: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ start: i, classDepth: 0, hasQuant: false });
      continue;
    }
    if (c === "*" || c === "+" || (c === "{" && /^\{\d*,\d*\}/.test(body.slice(i)))) {
      // mark the enclosing group as containing an unbounded quantifier
      const unbounded = c !== "{" || /^\{\d*,\}/.test(body.slice(i));
      if (stack.length && unbounded) stack[stack.length - 1].hasQuant = true;
    }
    if (c === ")") {
      const g = stack.pop();
      if (!g) continue;
      // is this group immediately quantified by an unbounded quantifier?
      const after = body.slice(i + 1);
      const quantified = /^[*+]/.test(after) || /^\{\d*,\}/.test(after) || /^\{[2-9]\d*,\d*\}/.test(after);
      if (g.hasQuant && quantified) return true;
      // propagate: a group that contained a quantifier makes its parent risky too
      if ((g.hasQuant || quantified) && stack.length) stack[stack.length - 1].hasQuant = true;
    }
  }
  return false;
}

const MAX_REGEX_SUBJECT = 50_000; // cap the string a regex runs over (poly-blowup)

function tokenize(src: string): Tok[] {
  if (src.length > 10_000) throw new ExprError("expression too long");
  const toks: Tok[] = [];
  let i = 0;
  const prev = () => toks[toks.length - 1];
  // A '/' begins a regex literal only where a VALUE can start (expression
  // start, after an operator/'('/',') — after a value it's division.
  const regexOk = () => {
    const p = prev();
    return !p || (p.kind === "op" && p.text !== ")" && p.text !== ".");
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let out = "";
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[++j];
          out += n === "n" ? "\n" : n === "t" ? "\t" : n;
        } else {
          out += src[j];
        }
      }
      if (j >= src.length) throw new ExprError("unterminated string");
      toks.push({ kind: "str", text: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i))!;
      toks.push({ kind: "num", text: m[0], num: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      toks.push({ kind: "ident", text: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === "/" && regexOk()) {
      let j = i + 1;
      let body = "";
      let inClass = false; // a '/' inside [...] doesn't end the literal
      for (; j < src.length; j++) {
        const ch = src[j];
        if (ch === "\\" && j + 1 < src.length) {
          body += ch + src[++j];
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        body += ch;
      }
      if (j >= src.length) throw new ExprError("unterminated regex");
      const fm = /^[a-z]*/.exec(src.slice(j + 1))![0];
      try {
        new RegExp(body, fm); // validate now so a bad pattern fails at parse time
      } catch {
        throw new ExprError("invalid regex");
      }
      // Reject catastrophic-backtracking shapes: attacker controls both the
      // pattern and the subject, and a single RegExp.exec can't be interrupted
      // by the step budget, so an unsafe pattern would hang the UI thread.
      if (looksCatastrophic(body)) throw new ExprError("unsafe regex (nested quantifier)");
      toks.push({ kind: "regex", text: body, body, flags: fm });
      i = j + 1 + fm.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    const op = OPS.find((o) => o === two) ?? OPS.find((o) => o === c);
    if (op) {
      toks.push({ kind: "op", text: op });
      i += op.length;
      continue;
    }
    throw new ExprError(`unexpected character '${c}'`);
  }
  toks.push({ kind: "eof", text: "" });
  return toks;
}

// ---------------------------------------------------------------------------
// Parser (Pratt / precedence climbing) → small AST.

type Ast =
  | { t: "lit"; v: Val }
  | { t: "regex"; body: string; flags: string }
  | { t: "ident"; name: string }
  | { t: "member"; obj: Ast; name: string }
  | { t: "call"; target: Ast | null; name: string; args: Ast[] } // target null = global fn
  | { t: "bin"; op: string; l: Ast; r: Ast }
  | { t: "un"; op: string; e: Ast };

const BIN_PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

function parseExpr(src: string): Ast {
  const toks = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (text: string) => {
    const t = next();
    if (t.kind !== "op" || t.text !== text) throw new ExprError(`expected '${text}'`);
  };

  function primary(): Ast {
    if (++depth > 200) throw new ExprError("expression too deeply nested");
    try {
      const t = next();
      if (t.kind === "num") return { t: "lit", v: t.num! };
      if (t.kind === "str") return { t: "lit", v: t.text };
      if (t.kind === "regex") {
        return { t: "regex", body: t.body ?? "", flags: t.flags ?? "" };
      }
      if (t.kind === "ident") {
        if (t.text === "true") return { t: "lit", v: true };
        if (t.text === "false") return { t: "lit", v: false };
        if (t.text === "null") return { t: "lit", v: null };
        if (peek().kind === "op" && peek().text === "(") {
          next();
          return { t: "call", target: null, name: t.text, args: argList() };
        }
        return { t: "ident", name: t.text };
      }
      if (t.kind === "op") {
        if (t.text === "(") {
          const e = expr(0);
          expect(")");
          return postfix(e);
        }
        if (t.text === "!") return { t: "un", op: "!", e: unaryOperand() };
        if (t.text === "-") return { t: "un", op: "-", e: unaryOperand() };
      }
      throw new ExprError(`unexpected token '${t.text}'`);
    } finally {
      depth--;
    }
  }

  function unaryOperand(): Ast {
    return postfix(primary());
  }

  function argList(): Ast[] {
    const args: Ast[] = [];
    if (peek().kind === "op" && peek().text === ")") {
      next();
      return args;
    }
    for (;;) {
      args.push(expr(0));
      const t = next();
      if (t.kind === "op" && t.text === ")") return args;
      if (!(t.kind === "op" && t.text === ",")) throw new ExprError("expected ',' or ')'");
    }
  }

  function postfix(e: Ast): Ast {
    for (;;) {
      const t = peek();
      if (t.kind === "op" && t.text === ".") {
        next();
        const id = next();
        if (id.kind !== "ident") throw new ExprError("expected property name after '.'");
        if (peek().kind === "op" && peek().text === "(") {
          next();
          e = { t: "call", target: e, name: id.text, args: argList() };
        } else {
          e = { t: "member", obj: e, name: id.text };
        }
        continue;
      }
      // Bracket access `obj["key"]` — the only way to reach a property whose
      // name has dashes/spaces (common in frontmatter), which the `.` form and
      // the identifier tokenizer can't express. Only string-literal keys.
      if (t.kind === "op" && t.text === "[") {
        next();
        const key = next();
        if (key.kind !== "str") throw new ExprError('expected a "string" key inside [ ]');
        const close = next();
        if (!(close.kind === "op" && close.text === "]")) throw new ExprError("expected ']'");
        e = { t: "member", obj: e, name: key.text };
        continue;
      }
      return e;
    }
  }

  function expr(minPrec: number): Ast {
    if (++depth > 200) throw new ExprError("expression too deeply nested");
    try {
      let left = postfix(primary());
      for (;;) {
        const t = peek();
        if (t.kind !== "op") return left;
        const prec = BIN_PREC[t.text];
        if (prec === undefined || prec < minPrec) return left;
        next();
        const right = expr(prec + 1);
        left = { t: "bin", op: t.text, l: left, r: right };
      }
    } finally {
      depth--;
    }
  }

  const ast = expr(0);
  if (peek().kind !== "eof") throw new ExprError("unexpected trailing input");
  return ast;
}

// Parsed-expression cache — a base re-evaluates the same expressions for every
// row, so parse once per distinct source string.
const astCache = new Map<string, Ast | ExprError>();
function cachedParse(src: string): Ast {
  let hit = astCache.get(src);
  if (hit === undefined) {
    if (astCache.size > 2000) astCache.clear();
    try {
      hit = parseExpr(src);
    } catch (e) {
      hit = e instanceof ExprError ? e : new ExprError(String(e));
    }
    astCache.set(src, hit);
  }
  if (hit instanceof ExprError) throw hit;
  return hit;
}

// ---------------------------------------------------------------------------
// Evaluation.

export interface EvalCtx {
  row: BaseRow;
  formulas: Record<string, string>;
  /** resolve file("path") / link.asFile() against the vault */
  lookupFile?: (target: string) => BaseRow | null;
  nowMs?: number; // injectable clock for tests
  /** shared per-view state (created by runView) */
  _steps?: { n: number };
  /** cumulative size (list elements + string chars) produced this evaluation */
  _alloc?: { n: number };
  /** wall-clock ms deadline (Date.now()); a backstop for anything the step and
   * alloc budgets can't see (e.g. a single regex exec) */
  _deadline?: number;
  _fmCache?: Map<string, Val>;
  _fmActive?: Set<string>;
  _vars?: Map<string, Val>;
  _errors?: (msg: string) => void;
}

const MAX_STEPS = 200_000;
const MAX_ALLOC = 5_000_000; // total list-elements + string-chars per evaluation

function step(ctx: EvalCtx): void {
  const s = (ctx._steps ??= { n: 0 });
  if (++s.n > MAX_STEPS) throw new ExprError("expression exceeded evaluation budget");
  // Deadline is checked sparsely (every 4096 steps) to keep Date.now() cost off
  // the hot path. It bounds runaway loops the step budget alone wouldn't (and is
  // a backstop; a single regex exec still can't be interrupted — hence the
  // static ReDoS guard + subject cap).
  if (ctx._deadline && (s.n & 4095) === 0 && Date.now() > ctx._deadline) {
    throw new ExprError("expression exceeded time budget");
  }
}

/** Charge `n` size-units against the allocation budget; throws when exceeded.
 * Guards value-doubling attacks (`reduce(acc + acc, ...)`) that produce huge
 * arrays/strings while consuming few evaluation steps. */
function charge(ctx: EvalCtx, n: number): void {
  const a = (ctx._alloc ??= { n: 0 });
  a.n += n;
  if (a.n > MAX_ALLOC) throw new ExprError("expression exceeded allocation budget");
}

/** Cap a string before running an attacker-supplied regex over it, bounding
 * worst-case (polynomial) backtracking time. */
function capSubject(s: string): string {
  return s.length > MAX_REGEX_SUBJECT ? s.slice(0, MAX_REGEX_SUBJECT) : s;
}

function isObj(v: Val): v is { [k: string]: unknown } {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof DateVal) &&
    !(v instanceof DurVal) &&
    !(v instanceof LinkVal) &&
    !(v instanceof FileVal) &&
    !(v instanceof RegexVal) &&
    !(v instanceof RenderVal)
  );
}

export function truthy(v: Val): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return !Number.isNaN(v);
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

/** Text form of a value — used for '+' concatenation, join(), display. */
export function toText(v: Val): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (v instanceof DateVal) return fmtDate(v.ms);
  if (v instanceof DurVal) return fmtDuration(v.ms);
  if (v instanceof LinkVal) return v.display ?? v.target;
  if (v instanceof FileVal) return v.row.basename;
  if (v instanceof RegexVal) return String(v.re);
  if (v instanceof RenderVal) return v.value;
  try {
    return JSON.stringify(v);
  } catch {
    return "[object]";
  }
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const time =
    d.getHours() || d.getMinutes() || d.getSeconds()
      ? ` ${p(d.getHours())}:${p(d.getMinutes())}`
      : "";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${time}`;
}

function fmtDuration(ms: number): string {
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return (neg ? "-" : "") + parts.join(" ");
}

/** Parse "YYYY-MM-DD[ HH:mm[:ss]]" / ISO-T as a LOCAL date (Obsidian
 * semantics: a bare date is local midnight, not UTC). */
export function parseDateStr(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(
    s.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, se, msec] = m;
  const dt = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h ?? 0),
    Number(mi ?? 0),
    Number(se ?? 0),
    Number((msec ?? "").padEnd(3, "0") || 0),
  );
  // Reject rollover (2024-13-45 must not silently become a valid date).
  if (dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) return null;
  return dt.getTime();
}

const DUR_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_592_000_000, // 30d — calendar-agnostic approximation
  y: 31_536_000_000, // 365d
};

/** A duration split into calendar-significant components (for calendar-aware
 * date math) plus a leftover-ms bucket for sub-day units. */
interface DurParts {
  months: number; // y*12 + M
  days: number; // d + w*7
  ms: number; // h/m/s/ms
}

/** Parse "1d", "2h30m", "1d 2h" duration strings. Null if unrecognized. */
export function parseDurationParts(s: string): DurParts | null {
  const src = s.trim();
  if (!src) return null;
  const parts: DurParts = { months: 0, days: 0, ms: 0 };
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|[smhdwMy])/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (src.slice(lastEnd, m.index).trim() !== "") return null; // garbage between units
    const n = parseFloat(m[1]);
    switch (m[2]) {
      case "y":
        parts.months += n * 12;
        break;
      case "M":
        parts.months += n;
        break;
      case "w":
        parts.days += n * 7;
        break;
      case "d":
        parts.days += n;
        break;
      default:
        parts.ms += n * DUR_UNITS[m[2]];
    }
    lastEnd = m.index + m[0].length;
    matched = true;
  }
  if (!matched || src.slice(lastEnd).trim() !== "") return null;
  return parts;
}

/** Total milliseconds of a duration string (calendar units approximated — used
 * for duration arithmetic and comparison, not date offsetting). */
export function parseDuration(s: string): number | null {
  const p = parseDurationParts(s);
  if (!p) return null;
  return p.months * DUR_UNITS.M + p.days * DUR_UNITS.d + p.ms;
}

/** Offset a date by a duration STRING using calendar-aware month/day setters
 * (so "1M" lands on the same day next month and "1d" survives DST), then apply
 * the sub-day ms remainder. `sign` is +1 or -1. */
function dateAddDurString(dateMs: number, dur: string, sign: number): number | null {
  const p = parseDurationParts(dur);
  if (!p) return null;
  const d = new Date(dateMs);
  if (p.months) d.setMonth(d.getMonth() + sign * p.months);
  if (p.days) d.setDate(d.getDate() + sign * p.days);
  return d.getTime() + sign * p.ms;
}

/** Coerce to a date-ms if possible (DateVal or a date-shaped string). */
function asDateMs(v: Val): number | null {
  if (v instanceof DateVal) return v.ms;
  if (typeof v === "string") return parseDateStr(v);
  return null;
}

function asDurMs(v: Val): number | null {
  if (v instanceof DurVal) return v.ms;
  if (typeof v === "string") return parseDuration(v);
  return null;
}

function isDurString(v: Val): boolean {
  return typeof v === "string" && parseDurationParts(v) !== null;
}

/** Offset a date-ms by a duration value (DurVal → ms math; duration string →
 * calendar-aware). `sign` is +1 or -1. Null if `dur` isn't a duration. */
function dateAddDur(dateMs: number, dur: Val, sign: number): number | null {
  if (dur instanceof DurVal) return dateMs + sign * dur.ms;
  if (typeof dur === "string") return dateAddDurString(dateMs, dur, sign);
  return null;
}

/** Ordering comparison. Null = incomparable. */
export function compareVals(a: Val, b: Val): number | null {
  if (a === null || b === null) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  // date-aware: DateVal vs DateVal/date-string
  if (a instanceof DateVal || b instanceof DateVal) {
    const am = asDateMs(a);
    const bm = asDateMs(b);
    return am !== null && bm !== null ? am - bm : null;
  }
  if (a instanceof DurVal || b instanceof DurVal) {
    const am = asDurMs(a);
    const bm = asDurMs(b);
    return am !== null && bm !== null ? am - bm : null;
  }
  if (typeof a === "number" || typeof b === "number") {
    const an = typeof a === "number" ? a : numFromStr(a);
    const bn = typeof b === "number" ? b : numFromStr(b);
    return an === null || bn === null ? null : an - bn;
  }
  if (typeof a === "string" && typeof b === "string") {
    return baseCollator.compare(a, b);
  }
  return null;
}

// One shared collator — building an Intl.Collator per comparison is ~20× the
// cost of reusing one across a 3k-row sort.
const baseCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Number from a string ONLY if it's a non-empty numeric string. Prevents
 * "" == 0 and "  " == 0 from being true (#18). */
function numFromStr(v: Val): number | null {
  if (typeof v !== "string") return null;
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function equalVals(a: Val, b: Val): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a instanceof LinkVal && b instanceof LinkVal) {
    return linkMatches(a, b.target) || linkMatches(b, a.target);
  }
  if (a instanceof LinkVal && typeof b === "string") return linkMatches(a, b);
  if (b instanceof LinkVal && typeof a === "string") return linkMatches(b, a);
  if (a instanceof DateVal || b instanceof DateVal) {
    const am = asDateMs(a);
    const bm = asDateMs(b);
    return am !== null && bm !== null && am === bm;
  }
  if (a instanceof DurVal || b instanceof DurVal) {
    const am = asDurMs(a);
    const bm = asDurMs(b);
    return am !== null && bm !== null && am === bm;
  }
  if (typeof a === "number" && typeof b === "string") {
    const n = numFromStr(b);
    return n !== null && a === n;
  }
  if (typeof a === "string" && typeof b === "number") {
    const n = numFromStr(a);
    return n !== null && n === b;
  }
  return a === b;
}

function stripMd(s: string): string {
  return s.replace(/\.md$/i, "");
}

function linkMatches(l: LinkVal, s: string): boolean {
  const t = stripMd(l.target).toLowerCase();
  const q = stripMd(s).toLowerCase();
  return t === q || t.split("/").pop() === q;
}

function num1(v: Val): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function coerceNumber(v: Val): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof DateVal || v instanceof DurVal) return v.ms;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function typeName(v: Val): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  if (v instanceof DateVal) return "date";
  if (v instanceof DurVal) return "duration";
  if (v instanceof LinkVal) return "link";
  if (v instanceof FileVal) return "file";
  if (v instanceof RegexVal) return "regexp";
  if (v instanceof RenderVal) return v.kind;
  if (typeof v === "object") return "object";
  return typeof v; // boolean | number | string
}

function evalAst(node: Ast, ctx: EvalCtx): Val {
  step(ctx);
  switch (node.t) {
    case "lit":
      return node.v;
    case "regex":
      return new RegexVal(new RegExp(node.body, node.flags));
    case "ident":
      return resolveIdent(node.name, ctx);
    case "member":
      return member(evalMemberBase(node.obj, ctx), node.name, ctx, node.obj);
    case "un": {
      const v = evalAst(node.e, ctx);
      if (node.op === "!") return !truthy(v);
      const n = coerceNumber(v);
      return n === null ? null : -n;
    }
    case "bin":
      return binOp(node, ctx);
    case "call":
      return node.target === null ? globalCall(node.name, node.args, ctx) : methodCall(node, ctx);
  }
}

/** `formula.x` needs the namespace itself, not a value — mark it. */
const FORMULA_NS = Symbol("formula");

function evalMemberBase(obj: Ast, ctx: EvalCtx): Val | typeof FORMULA_NS {
  if (obj.t === "ident" && obj.name === "formula") return FORMULA_NS;
  return evalAst(obj, ctx);
}

function resolveIdent(name: string, ctx: EvalCtx): Val {
  const vars = ctx._vars;
  if (vars?.has(name)) return vars.get(name)!;
  if (name === "file") return new FileVal(ctx.row);
  if (name === "note") return ctx.row.properties as Val;
  if (name === "formula") throw new ExprError("formula must be used as formula.<name>");
  // Bare identifier = note property shorthand (`price` ≡ `note.price`).
  return fromYaml(ctx.row.properties[name]);
}

export function evalFormula(name: string, ctx: EvalCtx): Val {
  const cache = (ctx._fmCache ??= new Map());
  if (cache.has(name)) return cache.get(name)!;
  const active = (ctx._fmActive ??= new Set());
  if (active.has(name)) return null; // formula cycle → null, never recursion
  const src = ctx.formulas[name];
  if (typeof src !== "string") return null;
  active.add(name);
  try {
    const v = evalAst(cachedParse(src), ctx);
    cache.set(name, v);
    return v;
  } catch (e) {
    ctx._errors?.(`formula ${name}: ${e instanceof Error ? e.message : e}`);
    cache.set(name, null);
    return null;
  } finally {
    active.delete(name);
  }
}

function member(base: Val | typeof FORMULA_NS, name: string, ctx: EvalCtx, objAst: Ast): Val {
  void objAst;
  if (base === FORMULA_NS) return evalFormula(name, ctx);
  if (base === null) return null;
  if (base instanceof FileVal) {
    const r = base.row;
    switch (name) {
      case "name":
        return r.name;
      case "basename":
        return r.basename;
      case "path":
        return r.path;
      case "folder":
        return r.folder;
      case "ext":
        return r.ext;
      case "size":
        return r.size;
      case "ctime":
        return new DateVal(r.ctime);
      case "mtime":
        return new DateVal(r.mtime);
      case "tags":
        return r.tags.slice();
      case "links":
        return r.linkKeys.map((k) => new LinkVal(k));
      case "properties":
        return r.properties as Val;
    }
    return null;
  }
  if (base instanceof DateVal) {
    const d = new Date(base.ms);
    switch (name) {
      case "year":
        return d.getFullYear();
      case "month":
        return d.getMonth() + 1;
      case "day":
        return d.getDate();
      case "hour":
        return d.getHours();
      case "minute":
        return d.getMinutes();
      case "second":
        return d.getSeconds();
      case "millisecond":
        return d.getMilliseconds();
    }
    return null;
  }
  if (typeof base === "string" && name === "length") return base.length;
  if (Array.isArray(base) && name === "length") return base.length;
  if (isObj(base)) return fromYaml(base[name]);
  return null;
}

function binOp(node: { op: string; l: Ast; r: Ast }, ctx: EvalCtx): Val {
  const { op } = node;
  if (op === "&&") {
    const l = evalAst(node.l, ctx);
    return truthy(l) ? evalAst(node.r, ctx) : l;
  }
  if (op === "||") {
    const l = evalAst(node.l, ctx);
    return truthy(l) ? l : evalAst(node.r, ctx);
  }
  const l = evalAst(node.l, ctx);
  const r = evalAst(node.r, ctx);
  switch (op) {
    case "==":
      return equalVals(l, r);
    case "!=":
      return !equalVals(l, r);
    case "<":
    case ">":
    case "<=":
    case ">=": {
      const c = compareVals(l, r);
      if (c === null) return false;
      return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
    }
    case "+": {
      if (typeof l === "number" && typeof r === "number") return l + r;
      // date ± duration, calendar-aware. A date is a DateVal OR a date-shaped
      // string (#13: `due + "1d"` must be date math, not string concat).
      const lDate = asDateMs(l);
      const rDate = asDateMs(r);
      if (l instanceof DateVal || (lDate !== null && (r instanceof DurVal || isDurString(r)))) {
        const res = dateAddDur(lDate!, r, +1);
        if (res !== null) return new DateVal(res);
      }
      if (r instanceof DateVal || (rDate !== null && (l instanceof DurVal || isDurString(l)))) {
        const res = dateAddDur(rDate!, l, +1);
        if (res !== null) return new DateVal(res);
      }
      if (l instanceof DurVal || r instanceof DurVal) {
        const a = asDurMs(l);
        const b = asDurMs(r);
        if (a !== null && b !== null) return new DurVal(a + b);
      }
      if (Array.isArray(l) && Array.isArray(r)) {
        charge(ctx, l.length + r.length);
        return [...l, ...r];
      }
      if (typeof l === "string" || typeof r === "string") {
        const s = toText(l) + toText(r);
        charge(ctx, s.length);
        return s;
      }
      return null;
    }
    case "-": {
      if (typeof l === "number" && typeof r === "number") return l - r;
      if (l instanceof DateVal || asDateMs(l) !== null) {
        const lms = asDateMs(l);
        if (lms !== null) {
          const rms = asDateMs(r);
          if (r instanceof DateVal || (rms !== null && !(r instanceof DurVal) && !isDurString(r))) {
            if (rms !== null) return new DurVal(lms - rms);
          }
          const res = dateAddDur(lms, r, -1);
          if (res !== null) return new DateVal(res);
        }
      }
      if (l instanceof DurVal || r instanceof DurVal) {
        const a = asDurMs(l);
        const b = asDurMs(r);
        if (a !== null && b !== null) return new DurVal(a - b);
      }
      const a = num1(l);
      const b = num1(r);
      return a !== null && b !== null ? a - b : null;
    }
    case "*":
    case "/":
    case "%": {
      const a = coerceNumber(l);
      const b = coerceNumber(r);
      if (a === null || b === null) return null;
      if (op === "*") return a * b;
      if (op === "/") return b === 0 ? null : a / b;
      return b === 0 ? null : a % b;
    }
  }
  return null;
}

function argVals(args: Ast[], ctx: EvalCtx): Val[] {
  return args.map((a) => evalAst(a, ctx));
}

function globalCall(name: string, argAsts: Ast[], ctx: EvalCtx): Val {
  switch (name) {
    case "if": {
      const c = evalAst(argAsts[0], ctx);
      if (truthy(c)) return argAsts.length > 1 ? evalAst(argAsts[1], ctx) : null;
      return argAsts.length > 2 ? evalAst(argAsts[2], ctx) : null;
    }
    case "date": {
      const [v] = argVals(argAsts, ctx);
      if (v instanceof DateVal) return v;
      const ms = typeof v === "string" ? parseDateStr(v) : null;
      return ms === null ? null : new DateVal(ms);
    }
    case "duration": {
      const [v] = argVals(argAsts, ctx);
      const ms = typeof v === "string" ? parseDuration(v) : v instanceof DurVal ? v.ms : null;
      return ms === null ? null : new DurVal(ms);
    }
    case "now":
      return new DateVal(ctx.nowMs ?? Date.now());
    case "today": {
      const d = new Date(ctx.nowMs ?? Date.now());
      d.setHours(0, 0, 0, 0);
      return new DateVal(d.getTime());
    }
    case "number": {
      const [v] = argVals(argAsts, ctx);
      return coerceNumber(v);
    }
    case "min":
    case "max": {
      const nums = argVals(argAsts, ctx)
        .flat()
        .map(coerceNumber)
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return null;
      return name === "min" ? Math.min(...nums) : Math.max(...nums);
    }
    case "list": {
      const [v] = argVals(argAsts, ctx);
      if (v === null) return [];
      return Array.isArray(v) ? v : [v];
    }
    case "link": {
      const [p, d] = argVals(argAsts, ctx);
      const target = p instanceof FileVal ? p.row.path : p instanceof LinkVal ? p.target : toText(p);
      if (!target) return null;
      return new LinkVal(target, d === undefined || d === null ? undefined : toText(d));
    }
    case "file": {
      const [p] = argVals(argAsts, ctx);
      const target = p instanceof FileVal ? p.row.path : p instanceof LinkVal ? p.target : toText(p);
      const row = ctx.lookupFile?.(target) ?? null;
      return row ? new FileVal(row) : null;
    }
    case "image": {
      const [p] = argVals(argAsts, ctx);
      return p === null ? null : new RenderVal("image", toText(p));
    }
    case "icon": {
      const [p] = argVals(argAsts, ctx);
      return p === null ? null : new RenderVal("icon", toText(p));
    }
    case "html": {
      // Rendered as plain text by Basalt (no HTML execution from a .base).
      const [p] = argVals(argAsts, ctx);
      return p === null ? null : new RenderVal("html", toText(p));
    }
    case "escapeHTML": {
      const [p] = argVals(argAsts, ctx);
      return toText(p)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    case "random":
      return Math.random();
  }
  throw new ExprError(`unknown function ${name}()`);
}

/** list.filter/map/reduce evaluate their expression per element with the
 * documented scoped variables (value, index, acc). */
function withVars(ctx: EvalCtx, vars: Record<string, Val>, fn: () => Val): Val {
  const prev = ctx._vars;
  ctx._vars = new Map(prev);
  for (const [k, v] of Object.entries(vars)) ctx._vars.set(k, v);
  try {
    return fn();
  } finally {
    ctx._vars = prev;
  }
}

function methodCall(node: { target: Ast | null; name: string; args: Ast[] }, ctx: EvalCtx): Val {
  const target = evalMemberBase(node.target!, ctx);
  const name = node.name;
  if (target === FORMULA_NS) throw new ExprError("formula.<name> is not callable");

  // any-type methods first (work on every value, including null)
  if (name === "isTruthy" && node.args.length === 0) return truthy(target);
  if (name === "isType") {
    const [t] = argVals(node.args, ctx);
    return typeName(target) === toText(t);
  }
  if (name === "toString" && node.args.length === 0) return toText(target);
  if (name === "isEmpty" && node.args.length === 0) {
    if (target === null) return true;
    if (typeof target === "string") return target.length === 0;
    if (Array.isArray(target)) return target.length === 0;
    if (target instanceof DateVal) return false; // documented: always false
    if (typeof target === "number") return false; // present number is not empty
    if (isObj(target)) return Object.keys(target).length === 0;
    return false;
  }
  if (target === null) return null;

  if (typeof target === "string") return stringMethod(target, name, node.args, ctx);
  if (typeof target === "number") return numberMethod(target, name, node.args, ctx);
  if (Array.isArray(target)) return listMethod(target, name, node.args, ctx);
  if (target instanceof DateVal) return dateMethod(target, name, node.args, ctx);
  if (target instanceof FileVal) return fileMethod(target, name, node.args, ctx);
  if (target instanceof LinkVal) return linkMethod(target, name, node.args, ctx);
  if (target instanceof RegexVal) {
    if (name === "matches") {
      const [v] = argVals(node.args, ctx);
      return target.re.test(capSubject(toText(v)));
    }
    return null;
  }
  if (isObj(target)) {
    if (name === "keys") return Object.keys(target);
    if (name === "values") return Object.values(target).map(fromYaml);
    return null;
  }
  return null;
}

function stringMethod(s: string, name: string, args: Ast[], ctx: EvalCtx): Val {
  const vals = () => argVals(args, ctx);
  switch (name) {
    case "contains":
      return s.includes(toText(vals()[0]));
    case "containsAll":
      return vals().every((v) => s.includes(toText(v)));
    case "containsAny": {
      const qs = vals();
      return qs.some((v) => s.includes(toText(v)));
    }
    case "endsWith":
      return s.endsWith(toText(vals()[0]));
    case "startsWith":
      return s.startsWith(toText(vals()[0]));
    case "lower":
      return s.toLowerCase();
    case "title":
      return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case "trim":
      return s.trim();
    case "repeat": {
      const n = coerceNumber(vals()[0]) ?? 0;
      if (n < 0 || n * s.length > 100_000) return null; // bound output size
      return s.repeat(Math.floor(n));
    }
    case "reverse":
      return [...s].reverse().join("");
    case "slice": {
      const v = vals();
      const a = coerceNumber(v[0]) ?? 0;
      const b = v.length > 1 ? (coerceNumber(v[1]) ?? undefined) : undefined;
      return s.slice(a, b);
    }
    case "replace": {
      const v = vals();
      const pat = v[0];
      const rep = toText(v[1]);
      if (pat instanceof RegexVal) {
        // .replace with a non-global regex replaces the first match (JS
        // semantics, which Obsidian's implementation shares). Subject capped to
        // bound polynomial regex blowup (the static guard blocks exponential).
        const out = capSubject(s).replace(pat.re, rep);
        charge(ctx, out.length);
        return out;
      }
      const out = s.split(toText(pat)).join(rep);
      charge(ctx, out.length);
      return out;
    }
    case "split": {
      const v = vals();
      const sep = v[0];
      const n = v.length > 1 ? (coerceNumber(v[1]) ?? undefined) : undefined;
      const parts = sep instanceof RegexVal ? capSubject(s).split(sep.re) : s.split(toText(sep));
      charge(ctx, parts.length);
      return n === undefined ? parts : parts.slice(0, n);
    }
  }
  return null;
}

function numberMethod(n: number, name: string, args: Ast[], ctx: EvalCtx): Val {
  const vals = () => argVals(args, ctx);
  switch (name) {
    case "abs":
      return Math.abs(n);
    case "ceil":
      return Math.ceil(n);
    case "floor":
      return Math.floor(n);
    case "round": {
      const d = args.length ? (coerceNumber(vals()[0]) ?? 0) : 0;
      const f = Math.pow(10, Math.max(0, Math.min(15, d)));
      return Math.round(n * f) / f;
    }
    case "toFixed": {
      const d = args.length ? (coerceNumber(vals()[0]) ?? 0) : 0;
      return n.toFixed(Math.max(0, Math.min(20, d)));
    }
  }
  return null;
}

function listMethod(list: Val[], name: string, args: Ast[], ctx: EvalCtx): Val {
  const vals = () => argVals(args, ctx);
  switch (name) {
    // args evaluated ONCE, not per element (#17)
    case "contains": {
      const q = vals()[0];
      return list.some((e) => equalVals(e, q));
    }
    case "containsAll": {
      const qs = vals();
      return qs.every((v) => list.some((e) => equalVals(e, v)));
    }
    case "containsAny": {
      const qs = vals();
      return qs.some((v) => list.some((e) => equalVals(e, v)));
    }
    case "join":
      return list.map(toText).join(toText(vals()[0] ?? ", "));
    case "flat": {
      // manual flatten — Array.flat(Infinity) blows up TS's recursive type,
      // and an explicit stack lets the eval budget bound adversarial nesting
      const out: Val[] = [];
      const stack: Val[] = [...list].reverse();
      while (stack.length) {
        step(ctx);
        const e = stack.pop()!;
        if (Array.isArray(e)) stack.push(...[...e].reverse());
        else out.push(e);
      }
      return out;
    }
    case "reverse":
      return [...list].reverse();
    case "unique": {
      const seen = new Set<string>();
      const out: Val[] = [];
      for (const e of list) {
        const k = typeName(e) + "|" + toText(e);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(e);
        }
      }
      return out;
    }
    case "sort":
      return [...list].sort((a, b) => compareVals(a, b) ?? 0); // compareVals uses baseCollator
    case "slice": {
      const v = vals();
      const a = coerceNumber(v[0]) ?? 0;
      const b = v.length > 1 ? (coerceNumber(v[1]) ?? undefined) : undefined;
      return list.slice(a, b);
    }
    case "filter": {
      if (!args.length) return list;
      return list.filter((e, i) =>
        truthy(withVars(ctx, { value: e, index: i }, () => evalAst(args[0], ctx))),
      );
    }
    case "map": {
      if (!args.length) return list;
      charge(ctx, list.length);
      return list.map((e, i) => withVars(ctx, { value: e, index: i }, () => evalAst(args[0], ctx)));
    }
    case "reduce": {
      if (!args.length) return null;
      let acc: Val = args.length > 1 ? evalAst(args[1], ctx) : null;
      list.forEach((e, i) => {
        acc = withVars(ctx, { value: e, index: i, acc }, () => evalAst(args[0], ctx));
      });
      return acc;
    }
    case "mean": {
      // used by the documented summaries example: values.mean()
      const nums = list.map(coerceNumber).filter((x): x is number => x !== null);
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }
  }
  return null;
}

function dateMethod(d: DateVal, name: string, args: Ast[], ctx: EvalCtx): Val {
  switch (name) {
    case "date": {
      const t = new Date(d.ms);
      t.setHours(0, 0, 0, 0);
      return new DateVal(t.getTime());
    }
    case "time": {
      const t = new Date(d.ms);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    }
    case "format": {
      const [f] = argVals(args, ctx);
      try {
        return formatMoment(new Date(d.ms), toText(f));
      } catch (e) {
        if (e instanceof UnsupportedTokenError) return fmtDate(d.ms);
        throw e;
      }
    }
    case "relative": {
      const now = ctx.nowMs ?? Date.now();
      const diff = d.ms - now;
      const abs = Math.abs(diff);
      const units: [number, string][] = [
        [31_536_000_000, "year"],
        [2_592_000_000, "month"],
        [604_800_000, "week"],
        [86_400_000, "day"],
        [3_600_000, "hour"],
        [60_000, "minute"],
      ];
      for (const [ms, label] of units) {
        if (abs >= ms) {
          const n = Math.round(abs / ms);
          const u = `${n} ${label}${n === 1 ? "" : "s"}`;
          return diff < 0 ? `${u} ago` : `in ${u}`;
        }
      }
      return "just now";
    }
  }
  return null;
}

function fileMethod(f: FileVal, name: string, args: Ast[], ctx: EvalCtx): Val {
  const r = f.row;
  const vals = () => argVals(args, ctx);
  switch (name) {
    case "asLink": {
      const [d] = vals();
      return new LinkVal(r.path, d === undefined || d === null ? undefined : toText(d));
    }
    case "hasProperty":
      return Object.prototype.hasOwnProperty.call(r.properties, toText(vals()[0]));
    case "hasTag": {
      // matches any of the arguments; nested tags match their parents
      return vals().some((v) => {
        const q = toText(v).replace(/^#/, "").toLowerCase();
        return q !== "" && r.tags.some((t) => t === q || t.startsWith(q + "/"));
      });
    }
    case "hasLink": {
      const [v] = vals();
      const q =
        v instanceof FileVal
          ? [v.row.path.toLowerCase(), v.row.basename.toLowerCase()]
          : v instanceof LinkVal
            ? [stripMd(v.target).toLowerCase()]
            : [stripMd(toText(v)).toLowerCase()];
      return q.some((k) => k !== "" && r.linkKeys.includes(k));
    }
    case "inFolder": {
      const q = toText(vals()[0]).replace(/^\/+|\/+$/g, "");
      if (q === "") return true; // vault root contains everything
      return r.folder === q || r.folder.startsWith(q + "/");
    }
  }
  return null;
}

function linkMethod(l: LinkVal, name: string, args: Ast[], ctx: EvalCtx): Val {
  switch (name) {
    case "asFile": {
      const row = ctx.lookupFile?.(l.target) ?? null;
      return row ? new FileVal(row) : null;
    }
    case "linksTo": {
      const [v] = argVals(args, ctx);
      if (v instanceof FileVal) {
        return linkMatches(l, v.row.path) || linkMatches(l, v.row.basename);
      }
      return linkMatches(l, toText(v));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filters, columns, views.

/** Evaluate one expression for a row. Errors are reported and yield null. */
export function evalExpr(src: string, ctx: EvalCtx): Val {
  try {
    return evalAst(cachedParse(src), ctx);
  } catch (e) {
    ctx._errors?.(`${src}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** and = all match; or = at least one; not = NONE may match (per the docs). */
export function evalFilter(node: FilterNode | undefined, ctx: EvalCtx): boolean {
  if (node === undefined) return true;
  if (typeof node === "string") return truthy(evalExpr(node, ctx));
  if ("and" in node) return node.and.every((n) => evalFilter(n, ctx));
  if ("or" in node) return node.or.length === 0 || node.or.some((n) => evalFilter(n, ctx));
  if ("not" in node) return !node.not.some((n) => evalFilter(n, ctx));
  return true;
}

/** Normalize a column/sort key: bare `price` means `note.price`. */
export function normalizeKey(key: string): string {
  if (key.startsWith("file.") || key.startsWith("formula.") || key.startsWith("note.")) return key;
  return `note.${key}`;
}

/** Evaluate a column key (file.x / note.x / formula.x) for a row. */
export function columnValue(key: string, ctx: EvalCtx): Val {
  const k = normalizeKey(key);
  if (k.startsWith("file.")) {
    return member(new FileVal(ctx.row), k.slice(5), ctx, { t: "ident", name: "file" });
  }
  if (k.startsWith("formula.")) return evalFormula(k.slice(8), ctx);
  return fromYaml(ctx.row.properties[k.slice(5)]);
}

/** Human column label: displayName override, else the property name. */
export function columnLabel(key: string, def: BaseDef): string {
  const k = normalizeKey(key);
  const d = def.display[k] ?? def.display[key] ?? (k.startsWith("note.") ? def.display[k.slice(5)] : undefined);
  if (d) return d;
  if (k.startsWith("note.")) return k.slice(5);
  if (k === "file.name") return "Name";
  return k;
}

export interface RowOut {
  row: BaseRow;
  cells: Val[];
}

export interface GroupOut {
  /** display label of the group key (empty-value rows group under "") */
  label: string;
  rows: RowOut[];
}

export interface ViewResult {
  view: BaseViewDef;
  columns: { key: string; label: string }[];
  /** non-null when the view has groupBy */
  groups: GroupOut[] | null;
  rows: RowOut[];
  /** per-column summary text (aligned with columns; null = none) */
  summary: (string | null)[] | null;
  total: number; // matches before limit
  truncated: boolean;
  errors: string[];
}

const BUILTIN_SUMMARIES: Record<string, (vals: Val[]) => Val> = {
  average: (v) => {
    const n = v.map(coerceNumber).filter((x): x is number => x !== null);
    return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
  },
  sum: (v) => {
    const n = v.map(coerceNumber).filter((x): x is number => x !== null);
    return n.length ? n.reduce((a, b) => a + b, 0) : null;
  },
  min: (v) => {
    const n = v.map(coerceNumber).filter((x): x is number => x !== null);
    return n.length ? Math.min(...n) : null;
  },
  max: (v) => {
    const n = v.map(coerceNumber).filter((x): x is number => x !== null);
    return n.length ? Math.max(...n) : null;
  },
  median: (v) => {
    const n = v
      .map(coerceNumber)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    if (!n.length) return null;
    const mid = n.length >> 1;
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  },
  earliest: (v) => {
    const ms = v.map(asDateMs).filter((x): x is number => x !== null);
    return ms.length ? new DateVal(Math.min(...ms)) : null;
  },
  latest: (v) => {
    const ms = v.map(asDateMs).filter((x): x is number => x !== null);
    return ms.length ? new DateVal(Math.max(...ms)) : null;
  },
  checked: (v) => v.filter((x) => x === true).length,
  unique: (v) => {
    const seen = new Set(v.filter((x) => x !== null).map((x) => typeName(x) + "|" + toText(x)));
    return seen.size;
  },
  count: (v) => v.filter((x) => x !== null).length,
};

/** Run one view over the rows. Deterministic given nowMs. */
export function runView(
  def: BaseDef,
  view: BaseViewDef,
  rows: BaseRow[],
  opts?: { nowMs?: number; lookupFile?: (t: string) => BaseRow | null },
): ViewResult {
  const errors: string[] = [];
  const seenErrors = new Set<string>();
  const reportError = (m: string) => {
    if (errors.length < 20 && !seenErrors.has(m)) {
      seenErrors.add(m);
      errors.push(m);
    }
  };
  // Resolve the now() clock ONCE per pass so now()/today() are internally
  // consistent across all rows (#14). The deadline is REAL wall-clock (not the
  // injectable test clock) — a backstop for anything the step/alloc budgets
  // can't interrupt.
  const nowMs = opts?.nowMs ?? Date.now();
  const deadline = Date.now() + 2000;
  const mkCtx = (row: BaseRow): EvalCtx => ({
    row,
    formulas: def.formulas,
    lookupFile: opts?.lookupFile,
    nowMs,
    _steps: { n: 0 },
    _alloc: { n: 0 },
    _deadline: deadline,
    _errors: reportError,
  });

  // 1. filter (global AND view)
  const matched: { row: BaseRow; ctx: EvalCtx }[] = [];
  for (const row of rows) {
    const ctx = mkCtx(row);
    if (evalFilter(def.filters, ctx) && evalFilter(view.filters, ctx)) matched.push({ row, ctx });
  }
  const total = matched.length;

  // 2. sort (multi-key; incomparables keep input order — Array.sort is stable)
  const sortSpecs = view.sort ?? [];
  if (sortSpecs.length) {
    const keys = matched.map(({ row, ctx }) => ({
      row,
      ctx,
      k: sortSpecs.map((s) => columnValue(s.property, ctx)),
    }));
    keys.sort((a, b) => {
      for (let i = 0; i < sortSpecs.length; i++) {
        const av = a.k[i];
        const bv = b.k[i];
        // nulls sort last regardless of direction
        if (av === null && bv === null) continue;
        if (av === null) return 1;
        if (bv === null) return -1;
        const c = compareVals(av, bv);
        if (c === null || c === 0) continue;
        return sortSpecs[i].direction === "DESC" ? -c : c;
      }
      return 0;
    });
    matched.length = 0;
    matched.push(...keys.map(({ row, ctx }) => ({ row, ctx })));
  }

  // 3. limit
  const limited = view.limit !== undefined ? matched.slice(0, view.limit) : matched;

  // 4. columns + cells. The file.name COLUMN displays as the file's link
  // (Obsidian behavior); expressions still see file.name as a plain string.
  const orderKeys = view.order?.length ? view.order : ["file.name"];
  const columns = orderKeys.map((key) => ({ key, label: columnLabel(key, def) }));
  const out: RowOut[] = limited.map(({ row, ctx }) => ({
    row,
    cells: orderKeys.map((key) =>
      normalizeKey(key) === "file.name" ? new FileVal(row) : columnValue(key, ctx),
    ),
  }));

  // 5. groupBy
  let groups: GroupOut[] | null = null;
  if (view.groupBy) {
    const g = view.groupBy;
    const buckets = new Map<string, GroupOut>();
    limited.forEach(({ ctx }, i) => {
      const v = columnValue(g.property, ctx);
      const label = toText(v);
      let b = buckets.get(label);
      if (!b) {
        b = { label, rows: [] };
        buckets.set(label, b);
      }
      b.rows.push(out[i]);
    });
    groups = [...buckets.values()].sort((a, b) => {
      const c = baseCollator.compare(a.label, b.label);
      return g.direction === "DESC" ? -c : c;
    });
  }

  // 6. summaries (per column, over the LIMITED rows — what the table shows).
  // Normalize both the spec keys and the lookup key so `summaries: {price: Sum}`
  // matches an `order: [note.price]` column and vice-versa (#15).
  let summary: (string | null)[] | null = null;
  if (view.summaries && Object.keys(view.summaries).length) {
    const specByKey = new Map<string, string>();
    for (const [k, s] of Object.entries(view.summaries)) specByKey.set(normalizeKey(k), s);
    summary = orderKeys.map((key) => {
      const spec = specByKey.get(normalizeKey(key));
      if (!spec) return null;
      const colIdx = orderKeys.indexOf(key);
      const vals = out.map((r) => r.cells[colIdx]);
      const builtin = BUILTIN_SUMMARIES[spec.toLowerCase()];
      let v: Val = null;
      if (builtin) {
        v = builtin(vals);
      } else {
        // custom summary formula from the base's `summaries` section
        const src = def.summaries[spec];
        if (src) {
          const ctx = mkCtx(limited[0]?.row ?? emptyRow());
          ctx._vars = new Map([["values", vals.filter((x) => x !== null)]]);
          v = evalExpr(src, ctx);
        }
      }
      return v === null ? null : toText(v);
    });
    if (summary.every((s) => s === null)) summary = null;
  }

  return {
    view,
    columns,
    groups,
    rows: out,
    summary,
    total,
    truncated: view.limit !== undefined && total > view.limit,
    errors,
  };
}

function emptyRow(): BaseRow {
  return {
    name: "",
    basename: "",
    path: "",
    folder: "",
    ext: "",
    size: 0,
    ctime: 0,
    mtime: 0,
    tags: [],
    linkKeys: [],
    properties: {},
  };
}

// ---------------------------------------------------------------------------
// Display: turn a cell value into renderable parts for the component.

export type CellPart =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; target: string }
  | { kind: "check"; checked: boolean }
  | { kind: "tag"; text: string }
  | { kind: "image"; src: string };

export function cellParts(v: Val): CellPart[] {
  if (v === null) return [];
  if (v === true || v === false) return [{ kind: "check", checked: v }];
  if (Array.isArray(v)) {
    const parts: CellPart[] = [];
    v.forEach((e, i) => {
      if (i > 0) parts.push({ kind: "text", text: ", " });
      parts.push(...cellParts(e));
    });
    return parts;
  }
  if (v instanceof LinkVal) return [{ kind: "link", text: v.display ?? stripMd(v.target).split("/").pop() ?? v.target, target: v.target }];
  if (v instanceof FileVal) return [{ kind: "link", text: v.row.basename, target: v.row.path }];
  if (v instanceof RenderVal) {
    if (v.kind === "image") return [{ kind: "image", src: v.value }];
    return [{ kind: "text", text: v.value }]; // html/icon rendered as plain text
  }
  const text = toText(v);
  // Frontmatter-style wikilink strings ("[[Note]]") render as links, tags as chips.
  if (typeof v === "string") {
    const wl = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(text);
    if (wl) return [{ kind: "link", text: wl[2] ?? wl[1], target: wl[1] }];
    if (/^#[\w/-]+$/.test(text)) return [{ kind: "tag", text }];
  }
  return text === "" ? [] : [{ kind: "text", text }];
}
