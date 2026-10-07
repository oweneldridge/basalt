import { describe, expect, it } from "vitest";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import { renumberLists } from "./listRenumber";

const edit = (doc: string, changes: ChangeSpec, userEvent?: string) =>
  EditorState.create({ doc, extensions: [renumberLists] }).update({ changes, userEvent }).state.doc.toString();

describe("numbered lists after an edit", () => {
  it("count on after an item is deleted", () => {
    expect(edit("1. a\n2. b\n3. c\n4. d", { from: 5, to: 10 }, "delete.line")).toBe("1. a\n2. c\n3. d");
  });
  it("number a new item after the one before it", () => {
    expect(edit("1. a\n2. b\n", { from: 10, insert: "1. c" }, "input.type")).toBe("1. a\n2. b\n3. c");
  });
  it("keep a number the user typed on the first item", () => {
    expect(edit("1. a\n2. b", { from: 0, to: 1, insert: "5" }, "input.type")).toBe("5. a\n6. b");
  });
  it("leave undo, a reload from disk and other text alone", () => {
    expect(edit("1. a\n3. b", { from: 0, insert: "" + "" }, "undo")).toBe("1. a\n3. b");
    expect(edit("1. a\n2. b", { from: 5, to: 7, insert: "7." })).toBe("1. a\n7. b");
    expect(edit("para\n\n1. a\n3. b", { from: 0, insert: "x" }, "input.type")).toBe("xpara\n\n1. a\n3. b");
  });
});
