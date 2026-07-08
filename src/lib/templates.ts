// Templater-style template processing. Supports Obsidian core `{{date}}`,
// `{{time}}`, `{{title}}` (via lib/daily) AND Templater `<% tp.* %>` tags for
// the common cases: dates, file metadata, cursor placement, and prompts.
//
// SAFETY: templates are user-authored, but we do NOT eval arbitrary JS. Each
// `<% %>` tag is parsed as a curated `tp.<namespace>.<member>[(args)]` call and
// dispatched to a fixed function table. An unrecognized tag is left as an
// empty string (and reported), never executed. This keeps the data-safety
// posture even for a template copied from an untrusted source.

import { formatMoment, UnsupportedTokenError } from "./daily";

export interface TemplateCtx {
  /** The target note's title (basename without extension). */
  title: string;
  /** The target note's parent folder (vault-relative; "" at root). */
  folder: string;
  /** The target note's vault-relative path (with .md). */
  path: string;
  /** Creation time (ms epoch) — 0 for a not-yet-created note. */
  ctime: number;
  /** "Now" in ms — injectable for tests. */
  now: number;
  /** Default `{{date}}` / `{{time}}` formats from the vault's core Templates
   * settings (`.obsidian/templates.json`); Obsidian's own defaults when unset. */
  dateFormat?: string;
  timeFormat?: string;
  /** Resolve a `tp.system.prompt(...)`; return null = user cancelled. */
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
}

export interface TemplateResult {
  text: string;
  /** Offset of `tp.file.cursor()` in the output, or null if none. */
  cursor: number | null;
  errors: string[];
}

const CURSOR_MARK = ""; // private-use sentinel for the caret; never in real text

function fmtDate(ms: number, fmt: string): string {
  try {
    return formatMoment(new Date(ms), fmt);
  } catch (e) {
    if (e instanceof UnsupportedTokenError) {
      const d = new Date(ms);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    throw e;
  }
}

/** Parse a tag's string/number arguments (a small literal list). */
function parseArgs(raw: string): (string | number)[] {
  const args: (string | number)[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)\s*(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const t = m[1].trim();
    if (t === "") continue;
    if ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) {
      args.push(t.slice(1, -1).replace(/\\(.)/g, "$1"));
    } else if (!Number.isNaN(Number(t))) {
      args.push(Number(t));
    } else {
      args.push(t);
    }
    if (re.lastIndex >= raw.length) break;
  }
  return args;
}

/** Evaluate one `tp.*` expression. Returns the replacement string, the cursor
 * sentinel, or null when it's a prompt (handled async by the caller). */
type TagResult = { text: string } | { prompt: { message: string; def: string } };

function evalTag(expr: string, ctx: TemplateCtx): TagResult | null {
  const e = expr.trim();
  // tp.file.cursor([n]) → sentinel
  if (/^tp\.file\.cursor\s*\(/.test(e)) return { text: CURSOR_MARK };

  const call = /^tp\.([a-z_]+)\.([a-z_]+)\s*(?:\(([\s\S]*)\))?\s*$/i.exec(e);
  if (!call) return null;
  const ns = call[1].toLowerCase();
  const fn = call[2].toLowerCase();
  const args = call[3] !== undefined ? parseArgs(call[3]) : [];
  const strArg = (i: number, d = "") => (typeof args[i] === "string" ? (args[i] as string) : d);

  if (ns === "date") {
    const dayMs = (offset: number) => {
      const d = new Date(ctx.now);
      d.setDate(d.getDate() + offset);
      return d.getTime();
    };
    switch (fn) {
      case "now":
        return { text: fmtDate(ctx.now, strArg(0, "YYYY-MM-DD")) };
      case "today":
        return { text: fmtDate(ctx.now, strArg(0, "YYYY-MM-DD")) };
      case "tomorrow":
        return { text: fmtDate(dayMs(1), strArg(0, "YYYY-MM-DD")) };
      case "yesterday":
        return { text: fmtDate(dayMs(-1), strArg(0, "YYYY-MM-DD")) };
    }
  }
  if (ns === "file") {
    switch (fn) {
      case "title":
        return { text: ctx.title };
      case "folder":
        // tp.file.folder(true) → absolute (full) folder path; else the name.
        return { text: strArg(0) === "true" ? ctx.path.replace(/\/[^/]*$/, "") : ctx.folder };
      case "path":
        return { text: ctx.path };
      case "creation_date":
        return { text: fmtDate(ctx.ctime || ctx.now, strArg(0, "YYYY-MM-DD HH:mm")) };
    }
  }
  if (ns === "system" && (fn === "prompt" || fn === "suggester")) {
    return { prompt: { message: strArg(0, "Enter a value"), def: strArg(1, "") } };
  }
  return null;
}

/** Process a template's `<% %>` and `{{ }}` tags. Async because prompts pause
 * for user input. `<%- ... -%>` whitespace trimming is honored. */
export async function applyTemplate(text: string, ctx: TemplateCtx): Promise<TemplateResult> {
  const errors: string[] = [];
  // First the Obsidian core {{date}}/{{time}}/{{title}} tags.
  let out = text.replace(/\{\{(date|time|title)(?::([^}]+))?\}\}/gi, (_m, key: string, fmt?: string) => {
    const k = key.toLowerCase();
    if (k === "title") return ctx.title;
    // Inline `{{date:FMT}}` wins; else the vault's configured default; else Obsidian's.
    const dflt = k === "time" ? (ctx.timeFormat ?? "HH:mm") : (ctx.dateFormat ?? "YYYY-MM-DD");
    return fmtDate(ctx.now, fmt ?? dflt);
  });

  // Then Templater <% %> tags (left-to-right; prompts awaited in order).
  const tagRe = /<%[-_]?\s*([\s\S]*?)\s*[-_]?%>/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(out))) {
    // whitespace control: `<%-` trims preceding, `-%>` trims following
    const rawTag = m[0];
    const trimBefore = rawTag.startsWith("<%-") || rawTag.startsWith("<%_");
    const trimAfter = rawTag.endsWith("-%>") || rawTag.endsWith("_%>");
    let before = out.slice(last, m.index);
    if (trimBefore) before = before.replace(/[ \t]*\n?$/, "");
    result += before;

    const tag = evalTag(m[1], ctx);
    if (tag === null) {
      errors.push(`Unsupported template tag: <% ${m[1].trim()} %>`);
    } else if ("text" in tag) {
      result += tag.text;
    } else {
      const val = await ctx.prompt(tag.prompt.message, tag.prompt.def);
      result += val ?? tag.prompt.def;
    }
    last = m.index + rawTag.length;
    if (trimAfter) {
      const rest = out.slice(last);
      const skip = /^[ \t]*\n/.exec(rest);
      if (skip) last += skip[0].length;
    }
  }
  result += out.slice(last);

  const cursor = result.indexOf(CURSOR_MARK);
  const finalText = result.split(CURSOR_MARK).join("");
  return { text: finalText, cursor: cursor < 0 ? null : cursor, errors };
}
