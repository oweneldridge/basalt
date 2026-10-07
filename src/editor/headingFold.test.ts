// Heading-section range logic — the gutter's foldability decision (Phase 3c).
// Obsidian only folds at headings; this is the predicate that enforces that.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree, foldEffect, foldedRanges } from "@codemirror/language";
import { headingFold, headingSectionAt, listItemSectionAt } from "./headingFold";

function stateFor(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: GFM })],
  });
  ensureSyntaxTree(state, doc.length, 5000); // force a full parse (no view here)
  return state;
}

/** The heading-section fold range for `lineNo` (1-based) as [fromLine, toLine]. */
function foldLines(doc: string, lineNo: number): [number, number] | null {
  const state = stateFor(doc);
  const line = state.doc.line(lineNo);
  const range = headingSectionAt(state, line.from);
  if (!range) return null;
  return [state.doc.lineAt(range.from).number, state.doc.lineAt(range.to).number];
}

describe("headingSectionAt", () => {
  it("folds a heading's body down to the next same-level heading", () => {
    const doc = ["# A", "a1", "a2", "# B", "b1"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 3]); // # A folds through a2
  });

  it("a section includes deeper subsections (## under #)", () => {
    const doc = ["# A", "a1", "## A.1", "x", "# B"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 4]); // # A swallows ## A.1 and its body
    expect(foldLines(doc, 3)).toEqual([3, 4]); // ## A.1 folds just its own body
  });

  it("a heading with no body below it is not foldable", () => {
    const doc = ["# A", "# B", "b"].join("\n");
    expect(foldLines(doc, 1)).toBeNull(); // nothing between # A and # B
  });

  it("the last heading folds to end of document", () => {
    const doc = ["# A", "a", "## Last", "x", "y"].join("\n");
    expect(foldLines(doc, 3)).toEqual([3, 5]);
  });

  it("a non-heading line is never foldable (Obsidian doesn't fold paragraphs)", () => {
    expect(foldLines(["# A", "body", "more"].join("\n"), 2)).toBeNull();
  });

  it("a higher-level heading stops a deeper section (## then #)", () => {
    const doc = ["## A", "a", "# B", "b"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 2]); // ## A stops at # B (higher level)
  });

  it("does not treat a '#' inside a fenced code block as a heading", () => {
    const doc = ["# Real", "```", "# not a heading", "still code", "```", "after"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 6]); // real heading folds the code block + after
    expect(foldLines(doc, 3)).toBeNull(); // the '#' line inside the fence isn't a heading
  });
});

describe("listItemSectionAt", () => {
  const listFold = (doc: string, lineNo: number): [number, number] | null => {
    const state = stateFor(doc);
    const r = listItemSectionAt(state, state.doc.line(lineNo).from);
    return r ? [state.doc.lineAt(r.from).number, state.doc.lineAt(r.to).number] : null;
  };
  it("folds a list item's deeper-indented children", () => {
    expect(listFold("- parent\n  - a\n  - b\n- sibling", 1)).toEqual([1, 3]);
  });
  it("returns null for a childless item and stops at a blank line / dedent", () => {
    expect(listFold("- solo\n- next", 1)).toBeNull();
    expect(listFold("- p\n  - child\n\n- after", 1)).toEqual([1, 2]);
  });
  it("handles ordered lists and nested depth", () => {
    expect(listFold("1. a\n   1. deep\n      - deeper\n2. b", 1)).toEqual([1, 3]);
  });
});

describe("deleting next to a folded section", () => {
  const doc = "# A\nhidden one\nhidden two\n# B\nafter";
  const folded = () => {
    const base = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: GFM }), headingFold] });
    ensureSyntaxTree(base, doc.length, 5000);
    const range = headingSectionAt(base, 0)!;
    return { state: base.update({ effects: foldEffect.of(range) }).state, range };
  };
  const del = (state: EditorState, from: number, to: number) =>
    state.update({ changes: { from, to }, userEvent: "delete.backward" }).state;

  it("opens it instead of joining the next line onto it", () => {
    const { state, range } = folded();
    const after = del(state, range.to, range.to + 1);
    expect(after.doc.toString()).toBe(doc);
    expect(foldedRanges(after).size).toBe(0);
  });
  it("opens it instead of pulling its text up into the heading", () => {
    const { state, range } = folded();
    const after = del(state, range.from, range.from + 1);
    expect(after.doc.toString()).toBe(doc);
    expect(foldedRanges(after).size).toBe(0);
  });
  it("deletes a selection the user made, hidden text and all", () => {
    const { state } = folded();
    const all = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
    for (const userEvent of ["delete.backward", "delete.cut"]) {
      const after = all.update({ changes: { from: 0, to: all.doc.length }, userEvent }).state;
      expect(after.doc.toString()).toBe("");
    }
  });
  it("lets Shift-Tab take indentation from a folded section's lines", () => {
    const list = "- a\n\t- b\n\t\t- c";
    const base = EditorState.create({ doc: list, extensions: [markdown({ base: markdownLanguage, extensions: GFM }), headingFold] });
    ensureSyntaxTree(base, list.length, 5000);
    const range = listItemSectionAt(base, base.doc.line(2).from)!;
    const state = base.update({ effects: foldEffect.of(range), selection: { anchor: base.doc.line(2).to } }).state;
    const after = state.update({ changes: [{ from: base.doc.line(2).from, to: base.doc.line(2).from + 1 }, { from: base.doc.line(3).from, to: base.doc.line(3).from + 1 }], userEvent: "delete.dedent" }).state;
    expect(after.doc.toString()).toBe("- a\n- b\n\t- c");
  });
  it("still opens a section a cursor's cut would take", () => {
    const { state, range } = folded();
    const after = state.update({ changes: { from: 0, to: range.to + 1 }, userEvent: "delete.cut" }).state;
    expect(after.doc.toString()).toBe(doc);
    expect(foldedRanges(after).size).toBe(0);
  });
  it("opens it when text is typed at its hidden end, so the text shows where it goes", () => {
    const { state, range } = folded();
    const after = state.update({ changes: { from: range.to, insert: "Z" }, userEvent: "input.type" }).state;
    expect(after.doc.toString()).toBe("# A\nhidden one\nhidden twoZ\n# B\nafter");
    expect(foldedRanges(after).size).toBe(0);
  });
  it("keeps it folded when Enter starts a line after it", () => {
    const { state, range } = folded();
    const after = state.update({ changes: { from: range.to, insert: "\n" }, userEvent: "input" }).state;
    expect(after.doc.toString()).toBe("# A\nhidden one\nhidden two\n\n# B\nafter");
    expect(foldedRanges(after).size).toBe(1);
  });
  it("still deletes the heading's own text", () => {
    const { state, range } = folded();
    const after = del(state, range.from - 1, range.from);
    expect(after.doc.toString()).toBe("# \nhidden one\nhidden two\n# B\nafter");
    expect(foldedRanges(after).size).toBe(1);
  });
});
