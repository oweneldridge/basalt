// Pure helpers for structurally editing a GFM Markdown table (add/remove rows
// and columns), used by the interactive table widget. Parse → mutate →
// serialize; the serializer pads columns so the raw Markdown stays aligned.

export type Align = "" | "left" | "center" | "right";

export interface ParsedTable {
  header: string[];
  aligns: Align[];
  /** Body rows (excludes header + delimiter). */
  rows: string[][];
}

// Split a row into trimmed cells on UNescaped pipes.
function splitCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function isDelimiter(line: string): boolean {
  return line.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
}

function parseAlign(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "";
}

/** Parse a table's source (the exact block, header + delimiter + body). */
export function parseTable(source: string): ParsedTable | null {
  const lines = source.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2 || !isDelimiter(lines[1])) return null;
  const header = splitCells(lines[0]);
  const aligns = splitCells(lines[1]).map(parseAlign);
  const rows = lines.slice(2).map((l) => splitCells(l));
  // Normalize to the WIDEST row (never truncate — a row with more cells than
  // the header, e.g. from an unescaped `|`, would otherwise lose text on the
  // next structural edit). Extra cells become real (empty-header) columns.
  const cols = Math.max(header.length, aligns.length, ...rows.map((r) => r.length));
  const pad = (arr: string[]): string[] => {
    const a = arr.slice();
    while (a.length < cols) a.push("");
    return a;
  };
  return { header: pad(header), aligns: pad(aligns) as Align[], rows: rows.map(pad) };
}

function delimiterCell(a: Align): string {
  switch (a) {
    case "center":
      return ":---:";
    case "right":
      return "---:";
    case "left":
      return ":---";
    default:
      return "---";
  }
}

// Re-escape a literal pipe in cell content so it doesn't read as a column
// separator (parseTable's splitCells unescaped it to a bare "|").
const escCell = (s: string): string => (s ?? "").replace(/\|/g, "\\|");

/** Serialize back to Markdown, padding each column to its widest cell. */
export function serializeTable(t: ParsedTable): string {
  const cols = t.header.length;
  const header = t.header.map(escCell);
  const rows = t.rows.map((r) => r.map(escCell));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = header[c]?.length ?? 0;
    for (const row of rows) w = Math.max(w, row[c]?.length ?? 0);
    widths[c] = Math.max(w, 3); // delimiter needs at least "---"
  }
  const pad = (s: string, c: number) => s + " ".repeat(Math.max(0, widths[c] - s.length));
  const row = (cells: string[]) => `| ${cells.map((cell, c) => pad(cell ?? "", c)).join(" | ")} |`;
  const delim = `| ${t.aligns.map((a, c) => pad(delimiterCell(a), c)).join(" | ")} |`;
  return [row(header), delim, ...rows.map((r) => row(r))].join("\n");
}

/** Insert an empty row at body index `at` (clamped). */
export function insertRow(t: ParsedTable, at: number): ParsedTable {
  const empty = t.header.map(() => "");
  const rows = t.rows.slice();
  rows.splice(Math.max(0, Math.min(at, rows.length)), 0, empty);
  return { ...t, rows };
}

/** Delete body row `at` (no-op if out of range). */
export function deleteRow(t: ParsedTable, at: number): ParsedTable {
  if (at < 0 || at >= t.rows.length) return t;
  const rows = t.rows.slice();
  rows.splice(at, 1);
  return { ...t, rows };
}

/** Insert an empty column at index `at` (clamped). */
export function insertColumn(t: ParsedTable, at: number): ParsedTable {
  const i = Math.max(0, Math.min(at, t.header.length));
  const header = t.header.slice();
  header.splice(i, 0, "");
  const aligns = t.aligns.slice();
  aligns.splice(i, 0, "");
  const rows = t.rows.map((r) => {
    const rr = r.slice();
    rr.splice(i, 0, "");
    return rr;
  });
  return { header, aligns, rows };
}

/** Delete column `at` (no-op if it's the last remaining column). */
export function deleteColumn(t: ParsedTable, at: number): ParsedTable {
  if (t.header.length <= 1 || at < 0 || at >= t.header.length) return t;
  const header = t.header.slice();
  header.splice(at, 1);
  const aligns = t.aligns.slice();
  aligns.splice(at, 1);
  const rows = t.rows.map((r) => {
    const rr = r.slice();
    rr.splice(at, 1);
    return rr;
  });
  return { header, aligns, rows };
}
