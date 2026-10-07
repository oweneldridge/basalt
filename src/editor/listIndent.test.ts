import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { indentListItem, outdentListItem } from "./listIndent";

const run = (cmd: (v: EditorView) => boolean, doc: string, line: number): string => {
  let state = EditorState.create({ doc, extensions: [indentUnit.of("\t")] });
  state = state.update({ selection: EditorSelection.cursor(state.doc.line(line).to) }).state;
  const view = { state, dispatch(tr: Transaction) { this.state = tr.state; } };
  cmd(view as unknown as EditorView);
  return view.state.doc.toString();
};

describe("Tab and Shift-Tab on a numbered item", () => {
  it("start a nested list at 1 and renumber the level left", () => {
    expect(run(indentListItem, "1. x\n2. y\n3. z", 2)).toBe("1. x\n\t1. y\n2. z");
  });
  it("count a lazy continuation line as part of the item above", () => {
    expect(run(indentListItem, "1. a\nlazy\n2. b\n3. c", 3)).toBe("1. a\nlazy\n\t1. b\n2. c");
  });
  it("stop at a paragraph, another delimiter or a bullet", () => {
    expect(run(indentListItem, "Intro\n\n1. x\n2. y\n3. z", 4)).toBe("Intro\n\n1. x\n\t1. y\n2. z");
    expect(run(indentListItem, "1. a\n2. b\n\n1) x\n2) y", 2)).toBe("1. a\n\t1. b\n\n1) x\n2) y");
    expect(run(indentListItem, "1. a\n2. b\n- bullet\n3. c", 2)).toBe("1. a\n\t1. b\n- bullet\n3. c");
    expect(run(indentListItem, "01. a\n02. b\n03. c", 2)).toBe("01. a\n\t1. b\n2. c");
  });
  it("stop at a line that starts a block of its own", () => {
    for (const between of ["<!-- note -->", "<div>", "| a | b |", "$$"]) {
      expect(run(indentListItem, `1. a\n2. b\n${between}\n1. x\n2. y`, 2), between).toBe(`1. a\n\t1. b\n${between}\n1. x\n2. y`);
    }
  });
  it("number the items left under an outdented one from 1", () => {
    expect(run(outdentListItem, "1. a\n\t1. b\n\t2. c\n2. d", 2)).toBe("1. a\n2. b\n\t1. c\n3. d");
  });
});
