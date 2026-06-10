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

// Split a table row into cells on UNescaped pipes, then unescape `\|`.
function splitCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

// The `|---|:--:|` alignment row.
function isDelimiter(line: string): boolean {
  return line.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
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

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const cell of headerCells) {
      const th = document.createElement("th");
      th.append(renderInline(cell));
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (let i = 1; i < lines.length; i++) {
      if (i === 1 && isDelimiter(lines[i])) continue;
      const cells = splitCells(lines[i]);
      const tr = document.createElement("tr");
      // Normalize ragged rows to the header's column count (GFM semantics).
      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        td.append(renderInline(cells[c] ?? ""));
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
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
