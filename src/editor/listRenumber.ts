// Numbered lists keep their count after any edit, as Obsidian keeps them: a
// numbered item on (or just after) a changed line takes the number after the
// item before it at its level, or, when it starts its list, the number that
// list started at before the edit; the items after it at that level count on
// from there. Only the user's own edits renumber, never a reload from disk.
import { EditorState, Transaction, type ChangeSpec, type Text } from "@codemirror/state";

/** A line's lead-in: quote markers and indentation, then maybe a list marker. */
interface Lead {
  prefix: string; // quote markers and whitespace before the marker
  marker: string | null; // `- `, `3. `, `3) ` with any task box, or null
  head: string | null; // the marker without its task box (`3. `)
  num: string | null; // a numbered marker's digits
  delim: string; // `.` or `)`
}

const LEAD = /^([>\s]*)(?:([*+-] |(\d+)([.)]) )(\[.\] )?)?/;
// Unindented lines a list can't run past: a quote, a heading, a rule, a fence.
const ENDS_LIST = /^\s*(?:> |#{1,6} |([-_*])(?:\s*\1){2,}\s*$|~~~|```)/;

function lead(text: string): Lead {
  const m = LEAD.exec(text)!;
  return { prefix: m[1], marker: m[2] ? m[2] + (m[5] ?? "") : null, head: m[2] ?? null, num: m[3] ?? null, delim: m[4] ?? "." };
}

/** How deep a line's lead-in sits: tabs, then four-space runs, counted inside
 * the first quote marker and outside it, as Obsidian counts list levels. */
function level(prefix: string): number {
  let rest = prefix;
  let n = 0;
  const indents = () => {
    while (rest.startsWith("\t")) (rest = rest.slice(1)), n++;
    while (rest.startsWith("    ")) (rest = rest.slice(4)), n++;
  };
  if (rest.startsWith(">")) {
    rest = rest.slice(1);
    indents();
    if (rest.startsWith(" ")) rest = rest.slice(1);
  }
  indents();
  return n;
}

const quotes = (prefix: string) => (prefix.match(/>/g) ?? []).length;

/** The number of the item before line `at` at the same level and quote
 * depth, or null when the list starts at `at` (a bullet, a shallower item, a
 * blank line after loose text, or a line that ends lists comes first). */
function numberBefore(doc: Text, at: number, lvl: number, depth: number): number | null {
  let loose = false;
  for (let k = at - 1; k >= 1; k--) {
    const text = doc.line(k).text;
    const l = lead(text);
    if (text && text !== l.prefix) {
      if (l.prefix || l.marker) {
        if (l.marker) {
          const kl = level(l.prefix);
          const kd = quotes(l.prefix);
          if (kl === lvl && kd === depth) return l.num ? parseInt(l.num, 10) : null;
          if (kl < lvl || kd < depth) return null;
        } else loose = true;
      } else {
        if (depth || ENDS_LIST.test(text)) return null;
        loose = true;
      }
    } else if (depth > quotes(l.prefix) || loose) return null;
  }
  return null;
}

/** The number the list holding line `at` (at this level and depth) starts at. */
function listStart(doc: Text, at: number, lvl: number, depth: number): number {
  let start = 1;
  let loose = false;
  for (let k = at; k >= 1; k--) {
    const text = doc.line(k).text;
    if (!text) {
      if (depth || loose) break;
      continue;
    }
    const l = lead(text);
    if (l.prefix || l.marker) {
      if (l.marker) {
        const kl = level(l.prefix);
        const kd = quotes(l.prefix);
        if (kl === lvl && kd === depth && l.num) start = parseInt(l.num, 10);
        if (kl < lvl || kd < depth) break;
      } else loose = true;
    } else {
      if (depth || ENDS_LIST.test(text)) break;
      loose = true;
    }
  }
  return start;
}

function renumber(tr: Transaction): ChangeSpec[] {
  const doc = tr.newDoc;
  const before = tr.startState.doc;
  const changed: { from: number; to: number }[] = [];
  const lines = new Set<number>();
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    changed.push({ from: fromB, to: toB });
    for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number + 1; n++) lines.add(n);
  });
  const done = new Set<number>();
  const out: ChangeSpec[] = [];
  const setNumber = (line: { from: number }, l: Lead, num: number) => {
    const from = line.from + l.prefix.length;
    out.push({ from, to: from + l.head!.length, insert: `${num}${l.delim} ` });
  };
  for (const n of [...lines].sort((a, b) => a - b)) {
    if (n > doc.lines || done.has(n)) continue;
    done.add(n);
    const line = doc.line(n);
    const l = lead(line.text);
    if (!l.num) continue;
    const lvl = level(l.prefix);
    const depth = quotes(l.prefix);
    let num = numberBefore(doc, n, lvl, depth);
    if (num === null) {
      // First in its list: the user's own number if they changed the marker,
      // else the number the list started at before the edit.
      const was = before.lineAt(tr.changes.invertedDesc.mapPos(line.to));
      const old = lead(was.text);
      const edited = changed.some((c) => c.from <= line.to && c.to >= line.from) && old.marker !== l.marker;
      num = edited ? parseInt(l.num, 10) : level(old.prefix) === lvl ? listStart(before, was.number, lvl, quotes(old.prefix)) : 1;
    } else num++;
    if (String(num) !== l.num) setNumber(line, l, num);
    // The items after it at its level count on.
    let gap = false;
    for (let k = n + 1; k <= doc.lines && !done.has(k); k++) {
      const next = doc.line(k);
      if (!next.text) {
        gap = true;
        continue;
      }
      const nl = lead(next.text);
      if (!nl.prefix && !nl.marker) {
        if (gap || ENDS_LIST.test(next.text)) break;
        continue;
      }
      if (nl.prefix && !nl.marker) continue;
      const kl = level(nl.prefix);
      if (kl === lvl && quotes(nl.prefix) === depth) {
        if (!nl.num) break;
        num++;
        done.add(k);
        if (String(num) === nl.num) break;
        setNumber(next, nl, num);
      }
      if (kl < lvl) break;
    }
  }
  return out;
}

export const renumberLists = EditorState.transactionFilter.of((tr) => {
  const event = tr.annotation(Transaction.userEvent);
  if (!tr.docChanged || !event || /^(undo|redo|input\.renumber|input\.type\.compose)/.test(event)) return tr;
  const changes = renumber(tr);
  return changes.length ? [tr, { changes, sequential: true, userEvent: "input.renumber" }] : tr;
});
