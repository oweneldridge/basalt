// A Dataview-style query engine for ```dataview code blocks. A focused DQL
// subset — TABLE / LIST / TASK with FROM / WHERE / SORT / GROUP BY / LIMIT /
// FLATTEN — evaluated over the vault. PURE and node-testable: rows in, a
// rendered result structure out.
//
// It reuses the value model and helpers from the Bases engine (lib/bases.ts):
// the same DateVal/DurVal/LinkVal types, comparison, date/duration parsing, and
// the same DoS posture (bounded evaluation). The expression sublanguage is
// DQL's (bare fields, function-call form, `and`/`or`/`not`, `=` equality),
// distinct from Bases' method form, so it gets its own tokenizer/parser here.

import {
  DateVal,
  DurVal,
  LinkVal,
  toText as valText,
  truthy as valTruthy,
  compareVals,
  parseDateStr,
  parseDuration,
  cellParts as baseCellParts,
  type Val,
  type BaseRow,
  type CellPart,
} from "./bases";

export type { Val, CellPart, BaseRow };
export { DateVal, DurVal, LinkVal };

// ---------------------------------------------------------------------------
// Query AST.

export type QueryKind = "TABLE" | "LIST" | "TASK";

export interface QueryColumn {
  expr: string; // source of the column expression
  name: string; // header
}

export type FromNode =
  | { t: "tag"; tag: string } // #tag (and nested)
  | { t: "folder"; folder: string } // "folder"
  | { t: "link"; target: string; dir: "in" | "out" } // [[Note]] incoming / outgoing([[Note]])
  | { t: "and"; l: FromNode; r: FromNode }
  | { t: "or"; l: FromNode; r: FromNode }
  | { t: "not"; e: FromNode };

export interface SortKey {
  expr: string;
  dir: "ASC" | "DESC";
}

export interface Query {
  kind: QueryKind;
  columns: QueryColumn[]; // TABLE
  withoutId: boolean; // TABLE WITHOUT ID
  listExpr?: string; // LIST <expr>
  from?: FromNode;
  where?: string;
  sort: SortKey[];
  groupBy?: string;
  limit?: number;
  flatten: { expr: string; as: string }[];
  error?: string; // set when the query text couldn't be parsed
}

// ---------------------------------------------------------------------------
// Query header/clause parsing (line + keyword oriented, like DQL).

const CLAUSES = ["FROM", "WHERE", "SORT", "GROUP BY", "GROUPBY", "LIMIT", "FLATTEN"];

/** Split a query into its leading command and clause segments, keeping each
 * clause's raw text. Case-insensitive keywords; a keyword only counts at a
 * clause boundary (start of a logical line), so it won't split inside strings. */
function splitClauses(src: string): { head: string; clauses: { kw: string; body: string }[] } {
  // Normalize newlines into spaces but remember token boundaries. We scan
  // token-wise so a quoted string can contain the word "from".
  const toks = tokenizeTop(src);
  const parts: { kw: string; start: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const up = toks[i].text.toUpperCase();
    // A clause keyword only counts at the TOP LEVEL — inside parens/brackets
    // (e.g. contains(x, "sort"), a list literal) it's part of an expression.
    if (toks[i].kind === "word" && toks[i].depth === 0) {
      // "GROUP BY" is two words.
      if (up === "GROUP" && toks[i + 1]?.text.toUpperCase() === "BY") {
        parts.push({ kw: "GROUP BY", start: toks[i].pos });
        i++;
        continue;
      }
      if (CLAUSES.includes(up)) parts.push({ kw: up === "GROUPBY" ? "GROUP BY" : up, start: toks[i].pos });
    }
  }
  const headEnd = parts.length ? parts[0].start : src.length;
  const head = src.slice(0, headEnd).trim();
  const clauses: { kw: string; body: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const kwLen = parts[i].kw.length;
    const bodyStart = parts[i].start + (parts[i].kw === "GROUP BY" ? "GROUP BY".length : kwLen);
    const bodyEnd = i + 1 < parts.length ? parts[i + 1].start : src.length;
    clauses.push({ kw: parts[i].kw, body: src.slice(bodyStart, bodyEnd).trim() });
  }
  return { head, clauses };
}

// A minimal top-level tokenizer used only to find clause keywords, tracking
// string and paren/bracket nesting so a keyword inside them doesn't split.
interface TopTok {
  kind: "word" | "string" | "other";
  text: string;
  pos: number;
  depth: number; // paren/bracket nesting at this token
}
function tokenizeTop(src: string): TopTok[] {
  const out: TopTok[] = [];
  let i = 0;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out.push({ kind: "string", text: src.slice(start, i), pos: start, depth });
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      out.push({ kind: "word", text: src.slice(start, i), pos: start, depth });
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    out.push({ kind: "other", text: c, pos: i, depth });
    i++;
  }
  return out;
}

/** Split a comma-separated list at top level (not inside quotes/brackets). */
function splitTopComma(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = src.slice(start).trim();
  if (last || out.length) out.push(last);
  return out.filter((s) => s.length > 0);
}

/** Index of the last top-level ` AS ` keyword (case-insensitive) that is NOT
 * inside a string or paren/bracket — so `contains(x, "a as b")` isn't mistaken
 * for an alias. Returns [asStart, afterAs] or null. */
function findTopLevelAs(src: string): [number, number] | null {
  let depth = 0;
  let found: [number, number] | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (
      depth === 0 &&
      (c === "a" || c === "A") &&
      /\s/.test(src[i - 1] ?? " ") &&
      (src[i + 1] === "s" || src[i + 1] === "S") &&
      /\s/.test(src[i + 2] ?? "")
    ) {
      found = [i, i + 3]; // last wins (Dataview allows a trailing rename)
    }
  }
  return found;
}

/** Parse a TABLE column spec: `expr` or `expr AS "Name"` / `expr AS Name`. */
function parseColumn(src: string): QueryColumn {
  const as = findTopLevelAs(src);
  if (as) {
    const expr = src.slice(0, as[0]).trim();
    const name = unquoteName(src.slice(as[1]).trim());
    return { expr, name: name || expr };
  }
  return { expr: src, name: defaultColumnName(src) };
}

function unquoteName(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function defaultColumnName(expr: string): string {
  // Dataview titles a bare field by its name; keep a readable default.
  return expr.trim();
}

/** Parse a FROM source expression: `#tag`, "folder", [[Note]], outgoing([[..]]),
 * combined with `and`/`or`/`-`/`not`. Returns undefined on empty/parse failure
 * (→ whole vault). */
function parseFrom(src: string): FromNode | undefined {
  const t = src.trim();
  if (!t) return undefined;
  try {
    const p = new FromParser(t);
    const node = p.parse();
    return node ?? undefined;
  } catch {
    return undefined;
  }
}

class FromParser {
  private i = 0;
  constructor(private s: string) {}
  private ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  private peekWord(): string | null {
    this.ws();
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.i));
    return m ? m[0] : null;
  }
  private eat(re: RegExp): RegExpExecArray | null {
    this.ws();
    const m = re.exec(this.s.slice(this.i));
    if (m && m.index === 0) {
      this.i += m[0].length;
      return m;
    }
    return null;
  }
  parse(): FromNode | null {
    return this.parseOr();
  }
  private parseOr(): FromNode | null {
    let l = this.parseAnd();
    for (;;) {
      const w = this.peekWord();
      if (w && w.toLowerCase() === "or") {
        this.eat(/^or/i);
        const r = this.parseAnd();
        if (l && r) l = { t: "or", l, r };
        else return l ?? r;
      } else break;
    }
    return l;
  }
  private parseAnd(): FromNode | null {
    let l = this.parseUnary();
    for (;;) {
      const w = this.peekWord();
      if (w && w.toLowerCase() === "and") {
        this.eat(/^and/i);
        const r = this.parseUnary();
        if (l && r) l = { t: "and", l, r };
        else return l ?? r;
      } else break;
    }
    return l;
  }
  private parseUnary(): FromNode | null {
    this.ws();
    if (this.s[this.i] === "-" || this.peekWord()?.toLowerCase() === "not") {
      if (this.s[this.i] === "-") this.i++;
      else this.eat(/^not/i);
      const e = this.parseUnary();
      return e ? { t: "not", e } : null;
    }
    return this.parseAtom();
  }
  private parseAtom(): FromNode | null {
    this.ws();
    if (this.s[this.i] === "(") {
      this.i++;
      const e = this.parseOr();
      this.eat(/^\)/);
      return e;
    }
    // outgoing([[..]]) / incoming
    const fn = this.eat(/^(outgoing|incoming)\s*\(/i);
    if (fn) {
      const link = this.eat(/^\s*\[\[([^\]]+)\]\]/);
      this.eat(/^\s*\)/);
      if (!link) return null;
      return { t: "link", target: link[1].trim(), dir: fn[1].toLowerCase() === "outgoing" ? "out" : "in" };
    }
    const tag = this.eat(/^#([A-Za-z0-9_\/\-]+)/);
    if (tag) return { t: "tag", tag: tag[1].toLowerCase() };
    const folder = this.eat(/^"([^"]*)"/);
    if (folder) return { t: "folder", folder: folder[1].replace(/^\/+|\/+$/g, "") };
    const link = this.eat(/^\[\[([^\]]+)\]\]/);
    if (link) return { t: "link", target: link[1].trim(), dir: "in" };
    return null;
  }
}

/** Parse a full DQL query string. Never throws — a bad query returns a Query
 * with `error` set so the block can render an error instead of crashing. */
export function parseQuery(src: string): Query {
  const q: Query = {
    kind: "LIST",
    columns: [],
    withoutId: false,
    sort: [],
    flatten: [],
  };
  try {
    const { head, clauses } = splitClauses(src);
    const headUp = head.toUpperCase();
    if (headUp.startsWith("TABLE")) {
      q.kind = "TABLE";
      let rest = head.slice(5).trim();
      if (/^WITHOUT\s+ID\b/i.test(rest)) {
        q.withoutId = true;
        rest = rest.replace(/^WITHOUT\s+ID\b/i, "").trim();
      }
      q.columns = rest ? splitTopComma(rest).map(parseColumn) : [];
    } else if (headUp.startsWith("TASK")) {
      q.kind = "TASK";
    } else if (headUp.startsWith("LIST")) {
      q.kind = "LIST";
      const rest = head.slice(4).trim();
      if (rest && !/^WITHOUT\s+ID$/i.test(rest)) q.listExpr = rest;
    } else if (head === "") {
      q.kind = "LIST";
    } else {
      // Unknown command word → treat as LIST with no expr, but flag it.
      q.error = `Unknown query type: "${head.split(/\s/)[0]}"`;
    }
    for (const c of clauses) {
      switch (c.kw) {
        case "FROM":
          q.from = parseFrom(c.body);
          break;
        case "WHERE":
          q.where = q.where ? `(${q.where}) and (${c.body})` : c.body;
          break;
        case "SORT":
          q.sort.push(
            ...splitTopComma(c.body).map((s) => {
              const m = /\s+(ASC|DESC)\s*$/i.exec(s);
              return {
                expr: (m ? s.slice(0, m.index) : s).trim(),
                dir: (m && m[1].toUpperCase() === "DESC" ? "DESC" : "ASC") as "ASC" | "DESC",
              };
            }),
          );
          break;
        case "GROUP BY": {
          const at = findTopLevelAs(c.body);
          q.groupBy = (at ? c.body.slice(0, at[0]) : c.body).trim();
          break;
        }
        case "LIMIT": {
          const n = parseInt(c.body, 10);
          if (Number.isFinite(n) && n >= 0) q.limit = n;
          break;
        }
        case "FLATTEN": {
          const at = findTopLevelAs(c.body);
          const expr = (at ? c.body.slice(0, at[0]) : c.body).trim();
          const as = at ? unquoteName(c.body.slice(at[1]).trim()) : expr;
          q.flatten.push({ expr, as });
          break;
        }
      }
    }
  } catch (e) {
    q.error = e instanceof Error ? e.message : String(e);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Expression language (DQL dialect). Reuses the Bases value model.

class QExprError extends Error {}

interface QTok {
  kind: "num" | "str" | "ident" | "op" | "link" | "tag" | "eof";
  text: string;
  num?: number;
}

const QOPS = ["<=", ">=", "!=", "<", ">", "=", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "."];

function qTokenize(src: string): QTok[] {
  if (src.length > 10_000) throw new QExprError("expression too long");
  const toks: QTok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
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
        } else out += src[j];
      }
      if (j >= src.length) throw new QExprError("unterminated string");
      toks.push({ kind: "str", text: out });
      i = j + 1;
      continue;
    }
    if (c === "[" && src[i + 1] === "[") {
      const end = src.indexOf("]]", i + 2);
      if (end < 0) throw new QExprError("unterminated [[link]]");
      toks.push({ kind: "link", text: src.slice(i + 2, end) });
      i = end + 2;
      continue;
    }
    if (c === "#") {
      const m = /^#([A-Za-z0-9_\/\-]+)/.exec(src.slice(i));
      if (m) {
        toks.push({ kind: "tag", text: m[1] });
        i += m[0].length;
        continue;
      }
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
    const two = src.slice(i, i + 2);
    const op = QOPS.find((o) => o === two) ?? QOPS.find((o) => o === c);
    if (op) {
      toks.push({ kind: "op", text: op });
      i += op.length;
      continue;
    }
    throw new QExprError(`unexpected character '${c}'`);
  }
  toks.push({ kind: "eof", text: "" });
  return toks;
}

type QAst =
  | { t: "lit"; v: Val }
  | { t: "link"; target: string }
  | { t: "tag"; tag: string }
  | { t: "list"; items: QAst[] }
  | { t: "ident"; name: string }
  | { t: "member"; obj: QAst; name: string }
  | { t: "index"; obj: QAst; idx: QAst }
  | { t: "call"; name: string; args: QAst[] }
  | { t: "bin"; op: string; l: QAst; r: QAst }
  | { t: "un"; op: string; e: QAst };

const QPREC: Record<string, number> = {
  or: 1,
  and: 2,
  "=": 3,
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

function qParse(src: string): QAst {
  const toks = qTokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isWordOp = (t: QTok) => t.kind === "ident" && (t.text.toLowerCase() === "and" || t.text.toLowerCase() === "or");

  function primary(): QAst {
    if (++depth > 200) throw new QExprError("expression too deeply nested");
    try {
      const t = next();
      if (t.kind === "num") return { t: "lit", v: t.num! };
      if (t.kind === "str") return { t: "lit", v: t.text };
      if (t.kind === "link") return { t: "link", target: t.text };
      if (t.kind === "tag") return { t: "tag", tag: t.text };
      if (t.kind === "ident") {
        const low = t.text.toLowerCase();
        if (low === "true") return { t: "lit", v: true };
        if (low === "false") return { t: "lit", v: false };
        if (low === "null") return { t: "lit", v: null };
        if (low === "not") return { t: "un", op: "not", e: unary() };
        if (peek().kind === "op" && peek().text === "(") {
          next();
          return { t: "call", name: t.text, args: argList() };
        }
        return { t: "ident", name: t.text };
      }
      if (t.kind === "op") {
        if (t.text === "(") {
          const e = expr(0);
          expect(")");
          return e;
        }
        if (t.text === "[") {
          const items: QAst[] = [];
          if (!(peek().kind === "op" && peek().text === "]")) {
            for (;;) {
              items.push(expr(0));
              const n = next();
              if (n.kind === "op" && n.text === "]") break;
              if (!(n.kind === "op" && n.text === ",")) throw new QExprError("expected , or ] in list");
            }
          } else next();
          return { t: "list", items };
        }
        if (t.text === "-") return { t: "un", op: "-", e: unary() };
      }
      throw new QExprError(`unexpected token '${t.text}'`);
    } finally {
      depth--;
    }
  }
  function unary(): QAst {
    return postfix(primary());
  }
  function argList(): QAst[] {
    const args: QAst[] = [];
    if (peek().kind === "op" && peek().text === ")") {
      next();
      return args;
    }
    for (;;) {
      args.push(expr(0));
      const n = next();
      if (n.kind === "op" && n.text === ")") return args;
      if (!(n.kind === "op" && n.text === ",")) throw new QExprError("expected , or )");
    }
  }
  function expect(op: string) {
    const t = next();
    if (!(t.kind === "op" && t.text === op)) throw new QExprError(`expected '${op}'`);
  }
  function postfix(e: QAst): QAst {
    for (;;) {
      const t = peek();
      if (t.kind === "op" && t.text === ".") {
        next();
        const id = next();
        if (id.kind !== "ident") throw new QExprError("expected name after .");
        e = { t: "member", obj: e, name: id.text };
        continue;
      }
      if (t.kind === "op" && t.text === "[") {
        next();
        const idx = expr(0);
        expect("]");
        e = { t: "index", obj: e, idx };
        continue;
      }
      return e;
    }
  }
  function expr(minPrec: number): QAst {
    if (++depth > 200) throw new QExprError("expression too deeply nested");
    try {
      let left = postfix(primary());
      for (;;) {
        const t = peek();
        let opName: string | null = null;
        if (t.kind === "op" && QPREC[t.text] !== undefined) opName = t.text;
        else if (isWordOp(t)) opName = t.text.toLowerCase();
        if (opName === null) return left;
        const prec = QPREC[opName];
        if (prec < minPrec) return left;
        next();
        const right = expr(prec + 1);
        left = { t: "bin", op: opName, l: left, r: right };
      }
    } finally {
      depth--;
    }
  }
  const ast = expr(0);
  if (peek().kind !== "eof") throw new QExprError("unexpected trailing input");
  return ast;
}

const astCache = new Map<string, QAst | QExprError>();
function cachedQParse(src: string): QAst {
  let hit = astCache.get(src);
  if (hit === undefined) {
    if (astCache.size > 2000) astCache.clear();
    try {
      hit = qParse(src);
    } catch (e) {
      hit = e instanceof QExprError ? e : new QExprError(String(e));
    }
    astCache.set(src, hit);
  }
  if (hit instanceof QExprError) throw hit;
  return hit;
}

// ---------------------------------------------------------------------------
// Task model (for TASK queries + file.tasks).

export interface Task {
  text: string; // task text (after the checkbox)
  checked: boolean;
  status: string; // the char inside [ ] (' ', 'x', '/', ...)
  line: number; // 0-based line index within the note
  path: string; // vault-relative note path
  indent: number; // leading whitespace length
  tags: string[];
  due?: number; // ms epoch, from 📅 YYYY-MM-DD or [due:: ...]
}

const TASK_RE = /^(\s*)[-*+]\s+\[(.)\]\s+(.*)$/;

/** Extract checkbox tasks from a note body. */
export function extractTasks(content: string, path: string): Task[] {
  const out: Task[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_RE.exec(lines[i].replace(/\r$/, ""));
    if (!m) continue;
    const text = m[3];
    const tags = [...text.matchAll(/(?:^|\s)#([A-Za-z0-9_\/\-]+)/g)].map((t) => t[1].toLowerCase());
    const dueM = /(?:📅|\[due::\s*)\s*(\d{4}-\d{2}-\d{2})/.exec(text);
    out.push({
      text,
      checked: m[2] !== " ",
      status: m[2],
      line: i,
      path,
      indent: m[1].length,
      tags,
      due: dueM ? (parseDateStr(dueM[1]) ?? undefined) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation context + fields.

export interface QueryCtx {
  row: BaseRow;
  /** The note the query BLOCK lives in (for `this`). */
  self: BaseRow;
  tasksOf: (path: string) => Task[];
  /** FLATTEN/GROUP scoped variables. */
  vars?: Map<string, Val>;
  steps?: { n: number };
  alloc?: { n: number };
  errors?: (m: string) => void;
}

const MAX_STEPS = 200_000;
const MAX_ALLOC = 2_000_000;
const MAX_WORK_ROWS = 50_000; // cap on FLATTEN row expansion
function qStep(ctx: QueryCtx) {
  const s = (ctx.steps ??= { n: 0 });
  if (++s.n > MAX_STEPS) throw new QExprError("evaluation budget exceeded");
}
function qCharge(ctx: QueryCtx, n: number) {
  const a = (ctx.alloc ??= { n: 0 });
  a.n += n;
  if (a.n > MAX_ALLOC) throw new QExprError("allocation budget exceeded");
}

function fromRaw(v: unknown): Val {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const wl = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(v);
    if (wl) return new LinkVal(wl[1], wl[2]);
    return v;
  }
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(fromRaw);
  if (v instanceof Date) return new DateVal(v.getTime());
  if (typeof v === "object") return v as Val;
  return null;
}

/** Implicit `file` object fields + a note's frontmatter. */
function fileField(row: BaseRow, name: string, ctx: QueryCtx): Val {
  switch (name) {
    case "name":
      return row.basename;
    case "link":
      return new LinkVal(row.path, row.basename);
    case "path":
      return row.path;
    case "folder":
      return row.folder;
    case "ext":
      return row.ext;
    case "size":
      return row.size;
    case "ctime":
    case "cday":
      return new DateVal(row.ctime);
    case "mtime":
    case "mday":
      return new DateVal(row.mtime);
    case "day": {
      // a date parsed from the filename (YYYY-MM-DD), like Dataview
      const m = /(\d{4}-\d{2}-\d{2})/.exec(row.basename);
      return m ? new DateVal(parseDateStr(m[1]) ?? 0) : null;
    }
    case "tags":
      return row.tags.map((t) => "#" + t);
    case "etags":
      return row.tags.map((t) => "#" + t);
    case "tasks":
      return ctx.tasksOf(row.path).map(taskToVal);
    case "starred":
      return false;
    default:
      return null;
  }
}

function taskToVal(t: Task): Val {
  return {
    text: t.text,
    checked: t.checked,
    status: t.status,
    line: t.line,
    path: t.path,
    due: t.due ? new DateVal(t.due) : null,
  } as unknown as Val;
}

function fmField(props: Record<string, unknown>, name: string): Val {
  if (Object.prototype.hasOwnProperty.call(props, name)) return fromRaw(props[name]);
  const low = name.toLowerCase();
  const hit = Object.keys(props).find((k) => k.toLowerCase() === low);
  return hit ? fromRaw(props[hit]) : null;
}

function resolveIdent(name: string, ctx: QueryCtx): Val {
  if (ctx.vars?.has(name)) return ctx.vars.get(name)!;
  const low = name.toLowerCase();
  if (low === "file") return new FileMarker(ctx.row); // the current row's file object
  if (low === "this") return new PageMarker(ctx.self); // the query note's page
  // Bare identifier = the current row's frontmatter field.
  return fmField(ctx.row.properties, name);
}

/** Marks a `file` reference so member access resolves file fields. */
class FileMarker {
  constructor(public row: BaseRow) {}
}
/** Marks `this` — a page. `this.file` is its file object; other members are
 * the page's frontmatter (Dataview semantics). */
class PageMarker {
  constructor(public row: BaseRow) {}
}

function evalQ(node: QAst, ctx: QueryCtx): Val {
  qStep(ctx);
  switch (node.t) {
    case "lit":
      return node.v;
    case "link":
      return new LinkVal(node.target.split("|")[0].trim(), node.target.includes("|") ? node.target.split("|")[1].trim() : undefined);
    case "tag":
      return "#" + node.tag;
    case "list":
      return node.items.map((it) => evalQ(it, ctx));
    case "ident":
      return resolveIdent(node.name, ctx);
    case "member": {
      const base = node.obj.t === "ident" ? resolveIdent(node.obj.name, ctx) : evalQ(node.obj, ctx);
      return memberOf(base, node.name, ctx);
    }
    case "index": {
      const base = evalQ(node.obj, ctx);
      const idx = evalQ(node.idx, ctx);
      if (Array.isArray(base) && typeof idx === "number") return base[idx] ?? null;
      if (isPlain(base) && typeof idx === "string") return fromRaw((base as Record<string, unknown>)[idx]);
      return null;
    }
    case "un": {
      const v = evalQ(node.e, ctx);
      if (node.op === "not") return !valTruthy(v);
      const n = asNum(v);
      return n === null ? null : -n;
    }
    case "bin":
      return binQ(node, ctx);
    case "call":
      return callQ(node.name, node.args, ctx);
  }
}

function memberOf(base: Val, name: string, ctx: QueryCtx): Val {
  if (base instanceof FileMarker) return fileField(base.row, name, ctx);
  if (base instanceof PageMarker) {
    return name.toLowerCase() === "file" ? new FileMarker(base.row) : fmField(base.row.properties, name);
  }
  if (base instanceof DateVal) return dateField(base, name);
  if (base instanceof LinkVal) {
    if (name === "path") return base.target;
    if (name === "display") return base.display ?? base.target;
    return null;
  }
  if (typeof base === "string" && name === "length") return base.length;
  if (Array.isArray(base) && name === "length") return base.length;
  if (isPlain(base)) return fromRaw((base as Record<string, unknown>)[name]);
  return null;
}

function dateField(d: DateVal, name: string): Val {
  const dt = new Date(d.ms);
  switch (name) {
    case "year":
      return dt.getFullYear();
    case "month":
      return dt.getMonth() + 1;
    case "day":
      return dt.getDate();
    case "hour":
      return dt.getHours();
    case "minute":
      return dt.getMinutes();
    case "second":
      return dt.getSeconds();
    case "weekday":
      return dt.getDay();
  }
  return null;
}

function isPlain(v: Val): v is { [k: string]: unknown } {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof DateVal) &&
    !(v instanceof DurVal) &&
    !(v instanceof LinkVal) &&
    !(v instanceof FileMarker) &&
    !(v instanceof PageMarker)
  );
}

function asNum(v: Val): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof DateVal || v instanceof DurVal) return v.ms;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function eqQ(a: Val, b: Val): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a instanceof LinkVal || b instanceof LinkVal) {
    const at = a instanceof LinkVal ? a.target : valText(a);
    const bt = b instanceof LinkVal ? b.target : valText(b);
    return at.replace(/\.md$/i, "").toLowerCase() === bt.replace(/\.md$/i, "").toLowerCase();
  }
  if (a instanceof DateVal || b instanceof DateVal) {
    const c = compareVals(a, b);
    return c === 0;
  }
  // Numeric coercion only for a NON-empty numeric string (so "" != 0, "x" != 0).
  if (typeof a === "number" && typeof b === "string") {
    const n = numStr(b);
    return n !== null && a === n;
  }
  if (typeof a === "string" && typeof b === "number") {
    const n = numStr(a);
    return n !== null && n === b;
  }
  return a === b;
}

function numStr(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function binQ(node: { op: string; l: QAst; r: QAst }, ctx: QueryCtx): Val {
  const { op } = node;
  if (op === "and") {
    const l = evalQ(node.l, ctx);
    return valTruthy(l) ? evalQ(node.r, ctx) : l;
  }
  if (op === "or") {
    const l = evalQ(node.l, ctx);
    return valTruthy(l) ? l : evalQ(node.r, ctx);
  }
  const l = evalQ(node.l, ctx);
  const r = evalQ(node.r, ctx);
  switch (op) {
    case "=":
      return eqQ(l, r);
    case "!=":
      return !eqQ(l, r);
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
      if (l instanceof DateVal && r instanceof DurVal) return new DateVal(l.ms + r.ms);
      if (l instanceof DurVal && r instanceof DateVal) return new DateVal(l.ms + r.ms);
      if (l instanceof DurVal && r instanceof DurVal) return new DurVal(l.ms + r.ms);
      if (Array.isArray(l) && Array.isArray(r)) {
        qCharge(ctx, l.length + r.length);
        return [...l, ...r];
      }
      if (typeof l === "string" || typeof r === "string") {
        const s = valText(l) + valText(r);
        qCharge(ctx, s.length);
        return s;
      }
      return null;
    }
    case "-": {
      if (typeof l === "number" && typeof r === "number") return l - r;
      if (l instanceof DateVal && r instanceof DateVal) return new DurVal(l.ms - r.ms);
      if (l instanceof DateVal && r instanceof DurVal) return new DateVal(l.ms - r.ms);
      const a = asNum(l);
      const b = asNum(r);
      return a !== null && b !== null ? a - b : null;
    }
    case "*":
    case "/":
    case "%": {
      const a = asNum(l);
      const b = asNum(r);
      if (a === null || b === null) return null;
      if (op === "*") return a * b;
      return b === 0 ? null : op === "/" ? a / b : a % b;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Functions (Dataview-ish).

function callQ(name: string, argAsts: QAst[], ctx: QueryCtx): Val {
  const args = () => argAsts.map((a) => evalQ(a, ctx));
  switch (name.toLowerCase()) {
    case "length": {
      const [v] = args();
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return v.length;
      if (v === null) return 0;
      return isPlain(v) ? Object.keys(v).length : 0;
    }
    case "contains":
    case "icontains": {
      const [a, b] = args();
      const ci = name.toLowerCase() === "icontains";
      if (Array.isArray(a)) {
        // list membership: honor case sensitivity consistently with the string form
        return a.some((e) => {
          if (eqQ(e, b)) return true;
          const et = ci ? valText(e).toLowerCase() : valText(e);
          const bt = ci ? valText(b).toLowerCase() : valText(b);
          return et.includes(bt);
        });
      }
      const hay = ci ? valText(a).toLowerCase() : valText(a);
      return hay.includes(ci ? valText(b).toLowerCase() : valText(b));
    }
    case "sum": {
      const [v] = args();
      const list = Array.isArray(v) ? v : [v];
      return list.reduce<number>((acc, x) => acc + (asNum(x) ?? 0), 0);
    }
    case "min":
    case "max": {
      const vs = args().flatMap((v) => (Array.isArray(v) ? v : [v]));
      const nums = vs.map(asNum).filter((n): n is number => n !== null);
      if (!nums.length) return null;
      return name.toLowerCase() === "min" ? Math.min(...nums) : Math.max(...nums);
    }
    case "round": {
      const [v, d] = args();
      const n = asNum(v);
      if (n === null) return null;
      const digits = Math.max(0, Math.min(15, asNum(d ?? 0) ?? 0));
      const f = Math.pow(10, digits);
      return Math.round(n * f) / f;
    }
    case "number": {
      const [v] = args();
      return asNum(v);
    }
    case "string": {
      const [v] = args();
      return valText(v);
    }
    case "lower": {
      return valText(args()[0]).toLowerCase();
    }
    case "upper": {
      return valText(args()[0]).toUpperCase();
    }
    case "default": {
      // Lazy: don't evaluate (and possibly error on) the fallback when the
      // primary value is present.
      const v = evalQ(argAsts[0], ctx);
      return v === null ? evalQ(argAsts[1] ?? { t: "lit", v: null }, ctx) : v;
    }
    case "choice": {
      const c = evalQ(argAsts[0], ctx);
      return valTruthy(c) ? evalQ(argAsts[1], ctx) : evalQ(argAsts[2] ?? { t: "lit", v: null }, ctx);
    }
    case "date": {
      // The Dataview idiom date(today) / date(now) uses a BARE keyword, which
      // would otherwise resolve as a (missing) frontmatter field → null.
      const a0 = argAsts[0];
      const kw = a0 && a0.t === "ident" ? a0.name.toLowerCase() : null;
      if (kw === "today" || kw === "tomorrow" || kw === "yesterday") {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        if (kw === "tomorrow") d.setDate(d.getDate() + 1);
        if (kw === "yesterday") d.setDate(d.getDate() - 1);
        return new DateVal(d.getTime());
      }
      if (kw === "now") return new DateVal(Date.now());
      const v = evalQ(a0, ctx);
      if (v instanceof DateVal) return v;
      const ms = parseDateStr(valText(v));
      return ms === null ? null : new DateVal(ms);
    }
    case "dur": {
      const [v] = args();
      const ms = v instanceof DurVal ? v.ms : parseDuration(valText(v));
      return ms === null ? null : new DurVal(ms);
    }
    case "dateformat": {
      const [v, fmt] = args();
      if (!(v instanceof DateVal)) return null;
      return formatDate(v.ms, valText(fmt));
    }
    case "link": {
      const [p, disp] = args();
      const target = p instanceof LinkVal ? p.target : valText(p);
      return new LinkVal(target, disp !== undefined && disp !== null ? valText(disp) : undefined);
    }
    case "regexmatch": {
      const [pat, s] = args();
      const re = safeRegex(valText(pat), "");
      if (!re) return false; // unsafe/invalid pattern → no match (never run)
      return re.test(valText(s).slice(0, MAX_RX_SUBJECT));
    }
    case "regexreplace": {
      const [s, pat, rep] = args();
      const re = safeRegex(valText(pat), "g");
      if (!re) return valText(s);
      const out = valText(s).slice(0, MAX_RX_SUBJECT).replace(re, valText(rep));
      qCharge(ctx, out.length);
      return out;
    }
    case "striptime": {
      const [v] = args();
      if (!(v instanceof DateVal)) return v;
      const d = new Date(v.ms);
      d.setHours(0, 0, 0, 0);
      return new DateVal(d.getTime());
    }
  }
  throw new QExprError(`unknown function ${name}()`);
}

const MAX_RX_SUBJECT = 5000; // cap the subject a regex runs over (bounds poly-time)

/** Reject regex patterns whose structure can backtrack catastrophically: a
 * group that contains an inner quantifier OR an alternation, immediately
 * followed by an outer quantifier (`*`/`+`/`{...}`). Covers `(a+)+`, `(a|a)*`,
 * `(a|ab)*`, `(.*a){20}`, `(.*){10}`, etc. Conservative — a rare safe pattern
 * of that shape is refused, which for a read-only query function is acceptable
 * (a heuristic denylist can't be sound, so we err toward refusing). */
function unsafeRegex(p: string): boolean {
  if (p.length > 1000) return true;
  const stack: { quant: boolean; alt: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
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
      stack.push({ quant: false, alt: false });
      continue;
    }
    if (c === "|") {
      if (stack.length) stack[stack.length - 1].alt = true;
      continue;
    }
    if (c === "*" || c === "+" || c === "{") {
      if (stack.length) stack[stack.length - 1].quant = true;
    }
    if (c === ")") {
      const g = stack.pop();
      if (!g) continue;
      const after = p[i + 1];
      const quantified = after === "*" || after === "+" || after === "{";
      if (quantified && (g.quant || g.alt)) return true;
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.quant = parent.quant || g.quant || quantified;
        parent.alt = parent.alt || g.alt;
      }
    }
  }
  return false;
}

/** Compile an untrusted pattern, or null if it's invalid or unsafe. */
function safeRegex(pattern: string, flags: string): RegExp | null {
  if (unsafeRegex(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(ms: number, fmt: string): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/yy/g, p(d.getFullYear() % 100))
    .replace(/MMM/g, MONTHS[d.getMonth()])
    .replace(/MM/g, p(d.getMonth() + 1))
    .replace(/dd/g, p(d.getDate()))
    .replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes()))
    .replace(/ss/g, p(d.getSeconds()));
}

/** Evaluate one expression against a row. Errors → null (reported). */
export function evalQueryExpr(src: string, ctx: QueryCtx): Val {
  try {
    return evalQ(cachedQParse(src), ctx);
  } catch (e) {
    ctx.errors?.(`${src}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FROM resolution + execution.

/** Does a row satisfy the FROM source? */
function matchesFrom(node: FromNode, row: BaseRow, incomingByTarget: Map<string, Set<string>>): boolean {
  switch (node.t) {
    case "tag":
      return row.tags.some((t) => t === node.tag || t.startsWith(node.tag + "/"));
    case "folder":
      return node.folder === "" || row.folder === node.folder || row.folder.startsWith(node.folder + "/");
    case "link": {
      if (node.dir === "out") {
        const key = node.target.replace(/\.md$/i, "").toLowerCase();
        return row.linkKeys.includes(key) || row.linkKeys.includes(key.split("/").pop() ?? key);
      }
      // incoming: this row links TO the target — per-target set of source paths
      return incomingByTarget.get(node.target)?.has(row.path) ?? false;
    }
    case "and":
      return matchesFrom(node.l, row, incomingByTarget) && matchesFrom(node.r, row, incomingByTarget);
    case "or":
      return matchesFrom(node.l, row, incomingByTarget) || matchesFrom(node.r, row, incomingByTarget);
    case "not":
      return !matchesFrom(node.e, row, incomingByTarget);
  }
}

export interface QueryResultRow {
  row: BaseRow;
  /** TABLE cell values (aligned with columns); LIST value; ignored for TASK. */
  cells: Val[];
  listValue?: Val;
  tasks?: Task[];
}

export interface QueryGroup {
  key: Val;
  label: string;
  rows: QueryResultRow[];
}

export interface QueryResult {
  kind: QueryKind;
  columns: string[]; // TABLE headers (incl. the id column unless WITHOUT ID)
  rows: QueryResultRow[];
  groups: QueryGroup[] | null;
  tasks: Task[]; // TASK: the flat matched task list
  total: number;
  errors: string[];
  error?: string; // fatal parse error
}

export interface RunQueryOpts {
  /** Every candidate note as a row (markdown notes; attachments optional). */
  rows: BaseRow[];
  /** The note the block lives in. */
  selfPath: string;
  tasksOf: (path: string) => Task[];
  /** For incoming-link FROM: given a target, the set of note paths linking to it. */
  incomingTo?: (target: string) => Set<string>;
}

const ID_HEADER = "File";

/** Execute a parsed query. Deterministic; never throws. */
export function runQuery(q: Query, opts: RunQueryOpts): QueryResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  const report = (m: string) => {
    if (errors.length < 20 && !seen.has(m)) {
      seen.add(m);
      errors.push(m);
    }
  };
  const self = opts.rows.find((r) => r.path === opts.selfPath) ?? emptyRow(opts.selfPath);

  const result: QueryResult = {
    kind: q.kind,
    columns: [],
    rows: [],
    groups: null,
    tasks: [],
    total: 0,
    errors,
    error: q.error,
  };
  if (q.error) return result;

  // 1. FROM → candidate rows. Incoming-link membership is kept PER TARGET so
  // `FROM [[A]] and [[B]]` means "links to A AND to B", not "to A or B".
  const incomingByTarget = new Map<string, Set<string>>();
  if (q.from) {
    for (const t of collectIncomingTargets(q.from)) {
      if (!incomingByTarget.has(t)) incomingByTarget.set(t, opts.incomingTo?.(t) ?? new Set());
    }
  }
  const candidates = q.from ? opts.rows.filter((r) => matchesFrom(q.from!, r, incomingByTarget)) : opts.rows.slice();

  // TASK: collect tasks (respecting FROM + WHERE + SORT over the tasks).
  if (q.kind === "TASK") {
    let tasks: Task[] = [];
    for (const row of candidates) {
      for (const t of opts.tasksOf(row.path)) {
        if (q.where) {
          const ctx = mkCtx(row, self, opts, report, taskVars(t));
          if (!valTruthy(evalQueryExpr(q.where, ctx))) continue;
        }
        tasks.push(t);
      }
    }
    if (q.sort.length) {
      const rowByPath = new Map(candidates.map((r) => [r.path, r]));
      const keyed = tasks.map((t) => ({
        t,
        keys: q.sort.map((s) =>
          evalQueryExpr(s.expr, mkCtx(rowByPath.get(t.path) ?? self, self, opts, report, taskVars(t))),
        ),
      }));
      keyed.sort((a, b) => sortCompare(a.keys, b.keys, q.sort));
      tasks = keyed.map((k) => k.t);
    }
    result.tasks = q.limit !== undefined ? tasks.slice(0, q.limit) : tasks;
    result.total = tasks.length;
    return result;
  }

  // 2. WHERE (+ FLATTEN expands rows).
  interface Work {
    row: BaseRow;
    vars: Map<string, Val>;
  }
  let work: Work[] = candidates.map((row) => ({ row, vars: new Map<string, Val>() }));
  // FLATTEN multiplies the working set (candidates × list-lengths per clause).
  // Cap the total to keep a crafted note (huge frontmatter list × several
  // FLATTENs) from exploding memory before LIMIT is even applied.
  let truncatedFlatten = false;
  outer: for (const fl of q.flatten) {
    const next: Work[] = [];
    for (const w of work) {
      const ctx = mkCtx(w.row, self, opts, report, w.vars);
      const v = evalQueryExpr(fl.expr, ctx);
      const items = Array.isArray(v) ? v : [v];
      for (const it of items) {
        if (next.length >= MAX_WORK_ROWS) {
          truncatedFlatten = true;
          work = next;
          break outer;
        }
        const vars = new Map(w.vars);
        vars.set(fl.as, it);
        next.push({ row: w.row, vars });
      }
    }
    work = next;
  }
  if (truncatedFlatten) report(`FLATTEN produced too many rows; showing the first ${MAX_WORK_ROWS}`);
  if (q.where) {
    work = work.filter((w) => valTruthy(evalQueryExpr(q.where!, mkCtx(w.row, self, opts, report, w.vars))));
  }
  result.total = work.length;

  // 3. SORT.
  if (q.sort.length) {
    const keyed = work.map((w) => ({
      w,
      keys: q.sort.map((s) => evalQueryExpr(s.expr, mkCtx(w.row, self, opts, report, w.vars))),
    }));
    keyed.sort((a, b) => sortCompare(a.keys, b.keys, q.sort));
    work = keyed.map((k) => k.w);
  }

  // 4. LIMIT — but when grouping, Dataview limits GROUPS, so defer to step 6.
  if (q.limit !== undefined && !q.groupBy) work = work.slice(0, q.limit);

  // 5. Build output rows (cells for TABLE, list value for LIST).
  const out: QueryResultRow[] = work.map((w) => {
    const ctx = mkCtx(w.row, self, opts, report, w.vars);
    if (q.kind === "TABLE") {
      return { row: w.row, cells: q.columns.map((c) => evalQueryExpr(c.expr, ctx)) };
    }
    const listValue = q.listExpr ? evalQueryExpr(q.listExpr, ctx) : new LinkVal(w.row.path, w.row.basename);
    return { row: w.row, cells: [], listValue };
  });
  result.rows = out;

  // Headers for TABLE.
  if (q.kind === "TABLE") {
    result.columns = q.withoutId ? q.columns.map((c) => c.name) : [ID_HEADER, ...q.columns.map((c) => c.name)];
  }

  // 6. GROUP BY. LIMIT applies to the number of GROUPS (Dataview semantics).
  if (q.groupBy) {
    const buckets = new Map<string, QueryGroup>();
    work.forEach((w, i) => {
      const key = evalQueryExpr(q.groupBy!, mkCtx(w.row, self, opts, report, w.vars));
      const label = valText(key);
      let g = buckets.get(label);
      if (!g) {
        g = { key, label, rows: [] };
        buckets.set(label, g);
      }
      g.rows.push(out[i]);
    });
    let groups = [...buckets.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
    if (q.limit !== undefined) groups = groups.slice(0, q.limit);
    result.groups = groups;
  }

  return result;
}

/** Multi-key comparator: nulls sort last (both directions), incomparables keep
 * input order (stable). */
function sortCompare(aKeys: Val[], bKeys: Val[], specs: SortKey[]): number {
  for (let i = 0; i < specs.length; i++) {
    const av = aKeys[i];
    const bv = bKeys[i];
    if (av === null && bv === null) continue;
    if (av === null) return 1;
    if (bv === null) return -1;
    const c = compareVals(av, bv);
    if (c === null || c === 0) continue;
    return specs[i].dir === "DESC" ? -c : c;
  }
  return 0;
}

function mkCtx(
  row: BaseRow,
  self: BaseRow,
  opts: RunQueryOpts,
  report: (m: string) => void,
  vars: Map<string, Val>,
): QueryCtx {
  return { row, self, tasksOf: opts.tasksOf, vars, steps: { n: 0 }, alloc: { n: 0 }, errors: report };
}

function taskVars(t: Task): Map<string, Val> {
  const m = new Map<string, Val>();
  m.set("text", t.text);
  m.set("checked", t.checked);
  m.set("status", t.status);
  m.set("due", t.due ? new DateVal(t.due) : null);
  return m;
}

function collectIncomingTargets(node: FromNode): string[] {
  const out: string[] = [];
  const walk = (n: FromNode) => {
    if (n.t === "link" && n.dir === "in") out.push(n.target);
    else if (n.t === "and" || n.t === "or") {
      walk(n.l);
      walk(n.r);
    } else if (n.t === "not") walk(n.e);
  };
  walk(node);
  return out;
}

function emptyRow(path: string): BaseRow {
  return {
    name: path.split("/").pop() ?? path,
    basename: (path.split("/").pop() ?? path).replace(/\.md$/i, ""),
    path,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    ext: "md",
    size: 0,
    ctime: 0,
    mtime: 0,
    tags: [],
    linkKeys: [],
    properties: {},
  };
}

/** Render a value into cell parts (reuses the Bases renderer). */
export function queryCellParts(v: Val): CellPart[] {
  return baseCellParts(v);
}
