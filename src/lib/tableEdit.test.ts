import { describe, expect, it } from "vitest";
import {
  parseTable,
  serializeTable,
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
} from "./tableEdit";

const SRC = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";

describe("tableEdit", () => {
  it("parses header, aligns, rows", () => {
    const t = parseTable("| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |")!;
    expect(t.header).toEqual(["a", "b", "c"]);
    expect(t.aligns).toEqual(["left", "center", "right"]);
    expect(t.rows).toEqual([["1", "2", "3"]]);
  });
  it("returns null for non-tables", () => {
    expect(parseTable("just text\nmore text")).toBeNull();
  });
  it("round-trips through serialize (padded + aligned)", () => {
    const t = parseTable(SRC)!;
    const out = serializeTable(t);
    expect(parseTable(out)).toEqual(t); // structurally identical
    expect(out.split("\n")).toHaveLength(4);
  });
  it("insertRow adds an empty body row", () => {
    const t = insertRow(parseTable(SRC)!, 1);
    expect(t.rows).toEqual([["1", "2"], ["", ""], ["3", "4"]]);
  });
  it("deleteRow removes a body row", () => {
    expect(deleteRow(parseTable(SRC)!, 0).rows).toEqual([["3", "4"]]);
  });
  it("insertColumn widens header, aligns, and every row", () => {
    const t = insertColumn(parseTable(SRC)!, 1);
    expect(t.header).toEqual(["a", "", "b"]);
    expect(t.aligns.length).toBe(3);
    expect(t.rows[0]).toEqual(["1", "", "2"]);
  });
  it("deleteColumn removes a column but never the last", () => {
    expect(deleteColumn(parseTable(SRC)!, 0).header).toEqual(["b"]);
    const single = parseTable("| a |\n| --- |\n| 1 |")!;
    expect(deleteColumn(single, 0)).toEqual(single); // last column protected
  });
  it("re-escapes literal pipes so an edit can't break the table", () => {
    const t = parseTable("| a | b |\n| --- | --- |\n| x \\| y | z |")!;
    expect(t.rows[0][0]).toBe("x | y"); // unescaped on parse
    const out = serializeTable(insertRow(t, 1));
    expect(out).toContain("x \\| y"); // re-escaped on serialize
    expect(parseTable(out)!.rows[0][0]).toBe("x | y"); // survives a round-trip
  });
  it("preserves extra cells in over-wide rows instead of deleting them", () => {
    const t = parseTable("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |")!;
    expect(t.header).toEqual(["a", "b", ""]); // promoted to 3 columns
    expect(t.rows[0]).toEqual(["1", "2", "3"]); // the extra "3" survives parse
    const out = serializeTable(insertRow(t, 1));
    expect(out).toContain("3"); // and survives a structural edit
    expect(parseTable(out)!.rows.find((r) => r.includes("3"))).toBeTruthy();
  });
});
