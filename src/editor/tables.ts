// Live Preview for GFM tables: replace a table's source lines with a rendered
// <table> (block widget) when the cursor is outside it; reveal the raw Markdown
// for editing when the cursor is inside.
//
// Block decorations (those that change vertical layout) must be provided from a
// StateField, not a ViewPlugin — CM computes the viewport before plugins run, so
// a plugin emitting block decorations throws at runtime. Hence the StateField.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, EditorSelection, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { renderInline } from "./inlineRender";
import { parseTable, serializeTable, insertRow, deleteRow, insertColumn, deleteColumn } from "../lib/tableEdit";
import type { ParsedTable } from "../lib/tableEdit";

// Split a table row into cells on UNescaped pipes, then unescape `\|`.
function splitCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

// Character offset where cell `col`'s content begins within a raw table line.
function cellOffsetInLine(line: string, col: number): number {
  let i = 0;
  if (line[i] === "|") i++; // skip a leading pipe
  let cell = 0;
  while (cell < col && i < line.length) {
    if (line[i] === "|" && line[i - 1] !== "\\") cell++;
    i++;
  }
  while (i < line.length && line[i] === " ") i++; // skip the cell's leading spaces
  return i;
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const lines = this.source.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      wrap.append(table);
      return wrap;
    }
    const headerCells = splitCells(lines[0]);
    const cols = headerCells.length;
    // Source-line index for each rendered row: header is line 0; body rows skip
    // the delimiter (line 1). Built alongside the DOM for cell-precise caret.
    const bodyLineIdx: number[] = [];
    for (let i = 2; i < lines.length; i++) bodyLineIdx.push(i);

    // The table's live document range, resolved at interaction time (positions
    // can shift between renders). source length matches the replaced block.
    const range = () => {
      const from = view.posAtDOM(wrap);
      return { from, to: from + this.source.length };
    };
    // Structurally edit the table (add/remove row/col) via the pure module.
    const edit = (fn: (t: ParsedTable) => ParsedTable) => (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const t = parseTable(this.source);
      if (!t) return;
      const { from, to } = range();
      view.dispatch({ changes: { from, to, insert: serializeTable(fn(t)) } });
    };
    // Reveal the raw source with the caret inside a specific cell.
    const editCell = (lineIdx: number, col: number) => (e: Event) => {
      const el = e.target as HTMLElement;
      if (el.closest(".cm-md-link") || el.closest(".cm-wikilink")) return; // let links navigate
      e.preventDefault();
      e.stopPropagation();
      const { from } = range();
      const before = lines.slice(0, lineIdx).reduce((n, l) => n + l.length + 1, 0);
      const pos = from + before + cellOffsetInLine(lines[lineIdx], col);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    };
    const ctrl = (cls: string, label: string, title: string, on: (e: Event) => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = `cm-table-ctrl ${cls}`;
      b.textContent = label;
      b.title = title;
      b.addEventListener("mousedown", on);
      return b;
    };

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headerCells.forEach((cell, c) => {
      const th = document.createElement("th");
      const content = document.createElement("span");
      content.className = "cm-table-cell";
      content.append(renderInline(cell));
      content.addEventListener("mousedown", editCell(0, c));
      th.append(content);
      // Per-column controls (delete this column, insert one to its right).
      const bar = document.createElement("span");
      bar.className = "cm-table-colbar";
      bar.append(
        ctrl("cm-table-delcol", "✕", "Delete column", edit((t) => deleteColumn(t, c))),
        ctrl("cm-table-addcol", "＋", "Insert column right", edit((t) => insertColumn(t, c + 1))),
      );
      th.append(bar);
      headRow.append(th);
    });
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    bodyLineIdx.forEach((lineIdx, bodyRow) => {
      const cells = splitCells(lines[lineIdx]);
      const tr = document.createElement("tr");
      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        const content = document.createElement("span");
        content.className = "cm-table-cell";
        content.append(renderInline(cells[c] ?? ""));
        content.addEventListener("mousedown", editCell(lineIdx, c));
        td.append(content);
        if (c === cols - 1) {
          const bar = document.createElement("span");
          bar.className = "cm-table-rowbar";
          bar.append(
            ctrl("cm-table-delrow", "✕", "Delete row", edit((t) => deleteRow(t, bodyRow))),
            ctrl("cm-table-addrow", "＋", "Insert row below", edit((t) => insertRow(t, bodyRow + 1))),
          );
          td.append(bar);
        }
        tr.append(td);
      }
      tbody.append(tr);
    });
    table.append(tbody);
    wrap.append(table);

    // Footer control: append a row / append a column to an all-empty-body table.
    const foot = document.createElement("div");
    foot.className = "cm-table-foot";
    foot.append(
      ctrl("cm-table-addrow-foot", "＋ Row", "Add row", edit((t) => insertRow(t, t.rows.length))),
      ctrl("cm-table-addcol-foot", "＋ Column", "Add column", edit((t) => insertColumn(t, t.header.length))),
    );
    wrap.append(foot);
    return wrap;
  }
  // Let control buttons / cell spans handle their own events; CM ignores them.
  ignoreEvent(event: Event): boolean {
    const t = event.target as HTMLElement | null;
    return !!t && (!!t.closest(".cm-table-ctrl") || !!t.closest(".cm-table-cell"));
  }
}

interface TableState {
  deco: DecorationSet;
  /** Line-snapped ranges of every table, for cheap touched-state checks. */
  ranges: { from: number; to: number }[];
}

function computeTables(state: EditorState): TableState {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: { from: number; to: number }[] = [];
  const { doc } = state;
  const sel = state.selection;
  const touches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      // Snap to whole lines — block replacements must cover full lines.
      const startLine = doc.lineAt(node.from);
      const endLine = doc.lineAt(node.to > node.from ? node.to - 1 : node.to);
      const from = startLine.from;
      const to = endLine.to;
      ranges.push({ from, to });
      if (touches(from, to)) return false; // editing: show raw
      const source = doc.sliceString(from, to);
      builder.add(from, to, Decoration.replace({ widget: new TableWidget(source), block: true }));
      return false;
    },
  });
  return { deco: builder.finish(), ranges };
}

// A cheap fingerprint of which tables the selection currently touches.
function touchedKey(ranges: { from: number; to: number }[], sel: EditorSelection): string {
  return ranges
    .map((r) => (sel.ranges.some((s) => s.from <= r.to && s.to >= r.from) ? "1" : "0"))
    .join("");
}

const tableField = StateField.define<TableState>({
  create: (state) => computeTables(state),
  update: (value, tr) => {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return computeTables(tr.state);
    }
    // On a pure selection change, only rebuild if a table's touched-state flipped
    // (cursor entered/left one) — otherwise the previous decorations still hold.
    if (tr.selection) {
      const before = touchedKey(value.ranges, tr.startState.selection);
      const after = touchedKey(value.ranges, tr.state.selection);
      if (before !== after) return computeTables(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

// A click on a block-replaced table maps to the block boundary, not inside the
// source, so the table never reveals for editing. Intercept and place the caret
// inside the table's source range instead (links/wikilinks in cells keep their
// own handlers).
const tableClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest(".cm-md-link") || target.closest(".cm-wikilink")) return false;
    const wrap = target.closest(".cm-md-table-wrap");
    if (!wrap) return false;
    const pos = view.posAtDOM(wrap as HTMLElement);
    event.preventDefault();
    view.dispatch({ selection: { anchor: pos } });
    return true;
  },
});

export const tables: Extension = [tableField, tableClick];
