// YAML frontmatter editing with a faithful round-trip. The cardinal rule for a
// shared vault: NEVER rewrite a key the user didn't edit. We parse the block
// just enough to locate each simple property's LINE SPAN; an edit replaces only
// that span and copies every other line — comments, blank lines, block scalars,
// anchors, nested objects — verbatim. Values the user types are re-serialized
// with conservative quoting (quote when in doubt; correct beats compact).
//
// This deliberately understands only the property shapes Obsidian's Properties
// UI produces — `key: scalar`, `key: [a, b]`, and `key:` + `- item` lists.
// Anything else is preserved but not offered for structured editing (edit the
// raw YAML instead).

// "complex" = a value the simple model can't safely round-trip (block scalar
// `|`/`>`, nested map, flow map, anchor/alias/tag). The UI shows it read-only.
export type PropKind = "scalar" | "inline" | "list" | "empty" | "complex";
/** Inferred YAML type of a scalar value — drives the typed Properties widget. */
export type PropType = "boolean" | "number" | "date" | "text";

export interface FmProp {
  key: string;
  values: string[];
  kind: PropKind;
  /** For scalar props: the value's inferred YAML type (checkbox/number/date/text). */
  type?: PropType;
  /** 0-based line indices within the BODY (between the `---` fences), inclusive. */
  start: number;
  end: number;
}

/** Infer a scalar's YAML type from its RAW (pre-unquote) text: an explicitly
 * quoted value is text; otherwise a bare bool / number / ISO date is typed. */
export function scalarType(rawVal: string): PropType {
  const t = rawVal.trim();
  if (/^["']/.test(t)) return "text";
  // YAML 1.1 booleans (Obsidian normalizes these to true/false on toggle).
  if (/^(true|false|yes|no|on|off)$/i.test(t)) return "boolean";
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return "number";
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return "date";
  return "text";
}

/** True when a bare YAML boolean scalar is truthy (true/yes/on). */
export function boolValue(rawVal: string): boolean {
  return /^(true|yes|on)$/i.test(rawVal.trim());
}

export interface ParsedFm {
  open: string; // opening fence line (without line terminator)
  close: string; // closing fence line
  body: string[]; // lines between the fences (CR-stripped)
  trailing: string[]; // lines after the closing fence (the note body)
  nl: string; // the file's line terminator ("\n" or "\r\n"), for faithful re-emit
  props: FmProp[];
}

/** Decode a double-quoted YAML scalar's escapes in a single pass (so `\\n`
 * stays backslash-n while `\n` becomes a newline — a naive global replace
 * conflates them). */
function decodeDoubleQuoted(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const n = inner[++i];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n; // \\→\, \"→", \n→newline
    } else {
      out += inner[i];
    }
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) return decodeDoubleQuoted(t.slice(1, -1));
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** True if `source` opens with a `---` fence and has a closing `---`/`...`. */
export function hasFrontmatter(source: string): boolean {
  const lines = source.split("\n");
  if (lines.length < 2 || lines[0].trim() !== "---") return false;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") return true;
  }
  return false;
}

/** Parse the leading frontmatter block. Returns null if there isn't one.
 * CRLF-tolerant: lines are CR-stripped for parsing and the terminator is
 * remembered so a rebuild re-emits the file's own newline style. */
export function parseFm(source: string): ParsedFm | null {
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length < 2 || lines[0].trim() !== "---") return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;

  const open = lines[0];
  const close = lines[closeIdx];
  const body = lines.slice(1, closeIdx);
  const trailing = lines.slice(closeIdx + 1); // the note body — preserved verbatim

  // Consume the indented continuation of a block scalar / nested map starting
  // after line `i`; returns the last consumed line index. A blank line only
  // continues the block if an indented line follows it.
  const consumeIndented = (i: number): number => {
    let end = i;
    for (let j = i + 1; j < body.length; j++) {
      if (/^\s+\S/.test(body[j])) {
        end = j;
        continue;
      }
      if (body[j].trim() === "") {
        let k = j + 1;
        while (k < body.length && body[k].trim() === "") k++;
        if (k < body.length && /^\s+\S/.test(body[k])) {
          end = k;
          j = k;
          continue;
        }
      }
      break;
    }
    return end;
  };

  // True if the next non-blank line after `i` is indented (an empty-valued key's
  // value can be a nested map / block scalar separated by a blank line).
  const nextNonBlankIndented = (i: number): boolean => {
    for (let j = i + 1; j < body.length; j++) {
      if (body[j].trim() === "") continue;
      return /^\s+\S/.test(body[j]);
    }
    return false;
  };

  const props: FmProp[] = [];
  for (let i = 0; i < body.length; i++) {
    const raw = body[i];
    if (/^\s*#/.test(raw) || raw.trim() === "") continue; // comment / blank: loose
    // A quoted key may legitimately contain a colon (`"a: b": v`); the simple kv
    // split would mangle it, so preserve such props verbatim (read-only).
    const quoted = /^\s*(["']).*?\1\s*:/.exec(raw);
    if (quoted) {
      const prop: FmProp = { key: raw.trim(), values: [], kind: "complex", start: i, end: i };
      if (/:\s*$/.test(raw) && nextNonBlankIndented(i)) prop.end = consumeIndented(i);
      i = prop.end;
      props.push(prop);
      continue;
    }
    const kv = /^([^:\s][^:]*?):\s*(.*)$/.exec(raw);
    if (!kv) continue; // a stray `- item` or unrecognized line: loose, preserved
    const key = kv[1].trim();
    const val = kv[2].trim();
    const prop: FmProp = { key, values: [], kind: "empty", start: i, end: i };

    if (val === "") {
      // Block list, block scalar / nested map (incl. blank-line-separated), or
      // a truly empty value.
      if (i + 1 < body.length && /^\s*-\s+/.test(body[i + 1])) {
        prop.kind = "list";
        let j = i + 1;
        for (; j < body.length; j++) {
          const li = /^\s*-\s+(.*)$/.exec(body[j]);
          if (!li) break;
          prop.values.push(unquote(li[1]));
          prop.end = j;
        }
        i = prop.end;
      } else if (nextNonBlankIndented(i)) {
        prop.kind = "complex"; // nested map / block scalar body (maybe after a blank)
        prop.end = consumeIndented(i);
        i = prop.end;
      }
      // else: stays kind "empty"
    } else if (/^[|>]/.test(val)) {
      prop.kind = "complex"; // block scalar header
      prop.end = consumeIndented(i);
      i = prop.end;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      // Inline array. Only offer structured editing when it splits cleanly on
      // commas (no quotes / nested brackets) — otherwise a naive split would
      // lose values, so keep it verbatim/read-only.
      const inner = val.slice(1, -1);
      if (/["'[\]{}]/.test(inner)) {
        prop.kind = "complex";
        prop.values = [val];
      } else {
        prop.kind = "inline";
        prop.values = inner
          .split(",")
          .map((s) => unquote(s))
          .filter((s) => s.length > 0);
      }
    } else if (/^[{&*!]/.test(val)) {
      prop.kind = "complex"; // flow map, anchor, alias, or tag
      prop.values = [val];
    } else {
      prop.kind = "scalar";
      prop.values = [unquote(val)];
      prop.type = scalarType(val);
    }
    props.push(prop);
  }

  // Duplicate keys are malformed (last-wins) but appear in real vaults. Editing
  // one by key name would hit the wrong span, so mark every occurrence complex
  // (read-only) — the structured editor never rewrites them.
  const counts = new Map<string, number>();
  for (const p of props) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
  for (const p of props) if ((counts.get(p.key) ?? 0) > 1) p.kind = "complex";

  return { open, close, body, trailing, nl, props };
}

/** Does a bare (unquoted) scalar value need quoting to round-trip safely? Errs
 * toward quoting — a needlessly-quoted value is harmless; an under-quoted one
 * corrupts the file. */
export function needsQuote(v: string): boolean {
  if (v === "") return true;
  if (/^\s|\s$/.test(v)) return true; // leading/trailing space
  if (/[\n"\\\t]/.test(v)) return true; // forces double-quoted + escaping
  if (/^[-?:,[\]{}#&*!|>'"%@`=]/.test(v)) return true; // YAML indicator at start
  if (/:(\s|$)/.test(v)) return true; // ": " maps to a mapping
  if (/\s#/.test(v)) return true; // " #" starts a comment
  // Bare words that YAML would read as a non-string (1.1 and 1.2 schemas — the
  // interop target, Obsidian, and downstream tools span both).
  if (/^(true|false|yes|no|on|off|null|~|y|n)$/i.test(v)) return true; // bools (incl. 1.1 y/n)
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return true; // decimal number
  if (/^[+-]?0(x[0-9a-fA-F_]+|o[0-7_]+|b[01_]+)$/.test(v)) return true; // hex / octal / binary
  if (/^[+-]?\.(inf|nan)$/i.test(v)) return true; // ±.inf / .nan
  if (/^[+-]?[0-9]+(:[0-5]?[0-9])+$/.test(v)) return true; // sexagesimal (12:34, 1:2:3)
  return false;
}

/** Serialize one scalar value, quoting (double-quoted with escapes) when needed. */
export function serializeScalar(v: string): string {
  if (!needsQuote(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** The body line(s) for a property, in Obsidian's style: a single value is a
 * scalar; multiple values are a block list. An empty value is `key:` (null). */
export function serializeProp(key: string, values: string[], multi: boolean, raw = false): string[] {
  const clean = values.filter((v) => v.length > 0);
  if (clean.length === 0) return [`${key}:`];
  const scalar = (v: string) => (raw ? v : serializeScalar(v));
  if (!multi && clean.length === 1) return [`${key}: ${scalar(clean[0])}`];
  return [`${key}:`, ...clean.map((v) => `  - ${scalar(v)}`)];
}

function rebuild(parsed: ParsedFm, body: string[]): string {
  return [parsed.open, ...body, parsed.close, ...parsed.trailing].join(parsed.nl);
}

/**
 * Set (or add) a property, replacing ONLY its line span. `multi` forces block-
 * list output (used for properties Obsidian always lists, like tags/aliases).
 * Returns the new frontmatter source, or the original if there's no block.
 */
export function setProp(
  source: string,
  key: string,
  values: string[],
  multi = false,
  raw = false,
): string {
  const parsed = parseFm(source);
  if (!parsed) return source;
  const newLines = serializeProp(key, values, multi, raw);
  const existing = parsed.props.find((p) => p.key === key);
  const body = parsed.body.slice();
  if (existing) {
    body.splice(existing.start, existing.end - existing.start + 1, ...newLines);
  } else {
    body.push(...newLines);
  }
  return rebuild(parsed, body);
}

/** Remove a property and its line span. No-op if the key isn't a simple prop. */
export function deleteProp(source: string, key: string): string {
  const parsed = parseFm(source);
  if (!parsed) return source;
  const existing = parsed.props.find((p) => p.key === key);
  if (!existing) return source;
  const body = parsed.body.slice();
  body.splice(existing.start, existing.end - existing.start + 1);
  return rebuild(parsed, body);
}
